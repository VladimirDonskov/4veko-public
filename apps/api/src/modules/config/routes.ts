import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { configRecords, configurations, registerMovements, users } from "../../db/schema";
import { compile } from "../../lang/checker";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { today } from "../../lib/dates";
import { AppError, notFound } from "../../lib/errors";
import { dec } from "../../lib/money";
import { isoDate, likePattern, uuidParam } from "../../lib/validation";
import {
  activeConfig,
  forgetConfig,
  labelsFor,
  lockRecord,
  metadata,
  postRecord,
  recordLabel,
  referenceLabels,
  resolveType,
  saveRecord,
  unpostRecord,
} from "./runtime";
import { SAMPLE_CONFIGURATION } from "./sample";
import { isRefType } from "./values";

const MAX_SOURCE = 500_000;
const diagnosticsOf = (source: string) =>
  compile(source).diagnostics.map((d) => ({ line: d.pos?.line ?? 0, col: d.pos?.col ?? 0, message: d.message, kind: d.kind }));

async function requireConfig(app: { db: Parameters<typeof activeConfig>[0] }, organizationId: string) {
  const cfg = await activeConfig(app.db, organizationId);
  if (!cfg) throw new AppError(404, "no_configuration", "This organization has no configuration yet. Open the Configurator to write one.");
  return cfg;
}

export const configRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { schema: { tags: ["Configuration"], summary: "Active configuration source and its objects" } }, async (req) => {
    const ctx = requireOrg(req);
    const cfg = await activeConfig(app.db, ctx.organizationId);
    if (!cfg) return { version: 0, source: "", metadata: metadata(compile("").schema) };
    return { version: cfg.version, source: cfg.source, metadata: metadata(cfg.schema) };
  });

  app.get("/sample", { schema: { tags: ["Configuration"], summary: "A sample configuration to start from" } }, async (req) => {
    requireOrg(req);
    return { source: SAMPLE_CONFIGURATION };
  });

  app.post(
    "/check",
    {
      schema: {
        tags: ["Configuration"],
        summary: "Check Veko source without saving it",
        body: z.object({ source: z.string().max(MAX_SOURCE) }),
      },
    },
    async (req) => {
      requireOrg(req);
      const diagnostics = diagnosticsOf(req.body.source);
      return { ok: diagnostics.length === 0, diagnostics, metadata: diagnostics.length ? null : metadata(compile(req.body.source).schema) };
    },
  );

  app.put(
    "/",
    {
      schema: {
        tags: ["Configuration"],
        summary: "Save a new version of the configuration (refused with diagnostics if it does not compile)",
        body: z.object({ source: z.string().max(MAX_SOURCE), comment: z.string().trim().max(500).optional() }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "config.manage");
      const diagnostics = diagnosticsOf(req.body.source);
      if (diagnostics.length) {
        return reply.status(422).send({
          error: { code: "configuration_invalid", message: `The configuration has ${diagnostics.length} problem(s).`, details: { diagnostics } },
        });
      }
      const saved = await app.db.transaction(async (tx) => {
        // Serialize concurrent saves per organization.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`config:${ctx.organizationId}`}))`);
        const [last] = await tx
          .select({ version: configurations.version })
          .from(configurations)
          .where(eq(configurations.organizationId, ctx.organizationId))
          .orderBy(desc(configurations.version))
          .limit(1);
        const version = (last?.version ?? 0) + 1;
        const [row] = await tx
          .insert(configurations)
          .values({ organizationId: ctx.organizationId, version, source: req.body.source, comment: req.body.comment ?? null, createdBy: ctx.userId })
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "configuration.saved",
          entityType: "configuration",
          entityId: row!.id,
          summary: `Saved configuration version ${version}${req.body.comment ? `: ${req.body.comment}` : ""}`,
          ip: ctx.ip,
        });
        return row!;
      });
      forgetConfig(ctx.organizationId);
      const cfg = await requireConfig(app, ctx.organizationId);
      return { version: saved.version, metadata: metadata(cfg.schema) };
    },
  );

  app.get("/versions", { schema: { tags: ["Configuration"], summary: "Configuration version history" } }, async (req) => {
    const ctx = requireOrg(req);
    return app.db
      .select({
        version: configurations.version,
        comment: configurations.comment,
        createdAt: configurations.createdAt,
        createdBy: users.name,
        lines: sql<number>`array_length(regexp_split_to_array(${configurations.source}, E'\\n'), 1)`,
      })
      .from(configurations)
      .leftJoin(users, eq(users.id, configurations.createdBy))
      .where(eq(configurations.organizationId, ctx.organizationId))
      .orderBy(desc(configurations.version))
      .limit(100);
  });

  app.get(
    "/versions/:version",
    { schema: { tags: ["Configuration"], summary: "Source of one version", params: z.object({ version: z.coerce.number().int().min(1) }) } },
    async (req) => {
      const ctx = requireOrg(req);
      const [row] = await app.db
        .select({ version: configurations.version, source: configurations.source, comment: configurations.comment, createdAt: configurations.createdAt })
        .from(configurations)
        .where(and(eq(configurations.organizationId, ctx.organizationId), eq(configurations.version, req.params.version)));
      if (!row) throw notFound("Configuration version");
      return row;
    },
  );
};

const recordBody = z.object({
  date: isoDate.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  post: z.boolean().optional(),
});
const typeParam = z.object({ type: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/) });

function present(r: typeof configRecords.$inferSelect, labels: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    kind: r.kind,
    typeName: r.typeName,
    number: r.number,
    date: r.date,
    posted: r.posted,
    data: r.data,
    tables: r.tables,
    journalEntryId: r.journalEntryId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    labels,
    ...extra,
  };
}

/** Generic endpoints for every catalog and document declared in the configuration. */
export const objectRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:type",
    {
      schema: {
        tags: ["Configuration objects"],
        summary: "List catalog items or documents of a configured type",
        params: typeParam,
        querystring: z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const cfg = await requireConfig(app, ctx.organizationId);
      const { decl } = resolveType(cfg.schema, req.params.type);
      const q = req.query.q;
      const rows = await app.db
        .select()
        .from(configRecords)
        .where(
          and(
            eq(configRecords.organizationId, ctx.organizationId),
            eq(configRecords.typeName, decl.name),
            q ? or(ilike(configRecords.number, likePattern(q)), sql`${configRecords.data}::text ilike ${likePattern(q)}`) : undefined,
          ),
        )
        .orderBy(desc(configRecords.createdAt))
        .limit(req.query.limit);
      const labels = await referenceLabels(app.db, ctx.organizationId, cfg.schema, rows);
      return { data: rows.map((r) => present(r, labels, { label: recordLabel(cfg.schema, r) })) };
    },
  );

  app.post(
    "/:type",
    { schema: { tags: ["Configuration objects"], summary: "Create a catalog item or document (optionally post it)", params: typeParam, body: recordBody } },
    async (req, reply) => {
      const ctx = requireOrg(req, "masterdata.write");
      const cfg = await requireConfig(app, ctx.organizationId);
      if (req.body.post) requireOrg(req, "journal.post");
      const result = await app.db.transaction(async (tx) => {
        const saved = await saveRecord(tx, ctx, cfg.schema, req.params.type, req.body, null);
        if (!req.body.post) return saved;
        const posted = await postRecord(tx, ctx, cfg.schema, saved.record);
        return { record: posted.record, messages: [...saved.messages, ...posted.messages] };
      });
      const labels = await referenceLabels(app.db, ctx.organizationId, cfg.schema, [result.record]);
      return reply.status(201).send(present(result.record, labels, { messages: result.messages }));
    },
  );

  app.get(
    "/:type/:id",
    { schema: { tags: ["Configuration objects"], summary: "Get one catalog item or document", params: typeParam.extend(uuidParam.shape) } },
    async (req) => {
      const ctx = requireOrg(req);
      const cfg = await requireConfig(app, ctx.organizationId);
      const { decl } = resolveType(cfg.schema, req.params.type);
      const [r] = await app.db
        .select()
        .from(configRecords)
        .where(and(eq(configRecords.organizationId, ctx.organizationId), eq(configRecords.typeName, decl.name), eq(configRecords.id, req.params.id)));
      if (!r) throw notFound(decl.name);
      const labels = await referenceLabels(app.db, ctx.organizationId, cfg.schema, [r]);
      const movements = await app.db
        .select({ register: registerMovements.register, dimensions: registerMovements.dimensions, resources: registerMovements.resources, period: registerMovements.period })
        .from(registerMovements)
        .where(and(eq(registerMovements.organizationId, ctx.organizationId), eq(registerMovements.recorderId, r.id)))
        .orderBy(registerMovements.id);
      const dimLabels = await labelsForMovements(app.db, ctx.organizationId, cfg.schema, movements);
      return present(r, { ...labels, ...dimLabels }, { movements });
    },
  );

  app.put(
    "/:type/:id",
    {
      schema: {
        tags: ["Configuration objects"],
        summary: "Update a catalog item or document. A posted document is unposted first and reposted if post is true.",
        params: typeParam.extend(uuidParam.shape),
        body: recordBody,
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "masterdata.write");
      const cfg = await requireConfig(app, ctx.organizationId);
      const { decl } = resolveType(cfg.schema, req.params.type);
      const result = await app.db.transaction(async (tx) => {
        let rec = await lockRecord(tx, ctx.organizationId, decl.name, req.params.id);
        if (rec.posted || req.body.post) requireOrg(req, "journal.post");
        if (rec.posted) rec = await unpostRecord(tx, ctx, cfg.schema, rec, today());
        const saved = await saveRecord(tx, ctx, cfg.schema, decl.name, req.body, rec);
        if (!req.body.post) return saved;
        const posted = await postRecord(tx, ctx, cfg.schema, saved.record);
        return { record: posted.record, messages: [...saved.messages, ...posted.messages] };
      });
      const labels = await referenceLabels(app.db, ctx.organizationId, cfg.schema, [result.record]);
      return present(result.record, labels, { messages: result.messages });
    },
  );

  for (const action of ["post", "unpost"] as const) {
    app.post(
      `/:type/:id/${action}`,
      { schema: { tags: ["Configuration objects"], summary: action === "post" ? "Post (or repost) a document" : "Unpost a document", params: typeParam.extend(uuidParam.shape) } },
      async (req) => {
        const ctx = requireOrg(req, "journal.post");
        const cfg = await requireConfig(app, ctx.organizationId);
        const { decl } = resolveType(cfg.schema, req.params.type);
        const result = await app.db.transaction(async (tx) => {
          const rec = await lockRecord(tx, ctx.organizationId, decl.name, req.params.id);
          if (action === "post") return postRecord(tx, ctx, cfg.schema, rec);
          return { record: await unpostRecord(tx, ctx, cfg.schema, rec, today()), messages: [] as string[] };
        });
        const labels = await referenceLabels(app.db, ctx.organizationId, cfg.schema, [result.record]);
        return present(result.record, labels, { messages: result.messages });
      },
    );
  }
};

async function labelsForMovements(
  db: Parameters<typeof labelsFor>[0],
  organizationId: string,
  schema: Parameters<typeof labelsFor>[2],
  movements: { register: string; dimensions: Record<string, string | null> }[],
) {
  const byType = new Map<string, Set<string>>();
  for (const m of movements) {
    const reg = schema.registers.get(m.register);
    for (const d of reg?.dimensions ?? []) {
      const v = m.dimensions[d.name];
      if (v && isRefType(d.type.name)) byType.set(d.type.name, (byType.get(d.type.name) ?? new Set()).add(v));
    }
  }
  return labelsFor(db, organizationId, schema, byType);
}

export const registerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:name/balances",
    {
      schema: {
        tags: ["Configuration objects"],
        summary: "Current balances of a register, grouped by its dimensions",
        params: z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/) }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const cfg = await requireConfig(app, ctx.organizationId);
      const reg = cfg.schema.registers.get(req.params.name);
      if (!reg) throw notFound(`Register "${req.params.name}"`);
      const rows = await app.db
        .select({ dimensions: registerMovements.dimensions, resources: registerMovements.resources })
        .from(registerMovements)
        .where(and(eq(registerMovements.organizationId, ctx.organizationId), eq(registerMovements.register, reg.name)));
      const groups = new Map<string, { dimensions: Record<string, string | null>; totals: Record<string, ReturnType<typeof dec>> }>();
      for (const row of rows) {
        const key = JSON.stringify(reg.dimensions.map((d) => row.dimensions[d.name] ?? null));
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { dimensions: row.dimensions, totals: Object.fromEntries(reg.resources.map((r) => [r.name, dec(0)])) }));
        for (const r of reg.resources) g.totals[r.name] = g.totals[r.name]!.plus(row.resources[r.name] ?? "0");
      }
      const balances = [...groups.values()]
        .map((g) => ({ dimensions: g.dimensions, resources: Object.fromEntries(Object.entries(g.totals).map(([k, v]) => [k, v.toFixed()])) }))
        .filter((b) => Object.values(b.resources).some((v) => v !== "0"));
      const labels = await labelsForMovements(app.db, ctx.organizationId, cfg.schema, balances.map((b) => ({ register: reg.name, dimensions: b.dimensions })));
      return {
        register: { name: reg.name, nonnegative: reg.nonnegative, dimensions: reg.dimensions.map((d) => ({ name: d.name, type: d.type.name })), resources: reg.resources.map((r) => ({ name: r.name, type: r.type.name })) },
        balances,
        labels,
      };
    },
  );
};
