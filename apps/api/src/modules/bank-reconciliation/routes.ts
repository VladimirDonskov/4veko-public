import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireOrg } from "../../lib/context";
import { uuidParam } from "../../lib/validation";
import { getStatement, statementDetail, statements } from "./queries";
import { changeMatch, discard, importBody, importStatement, setClosed } from "./service";

const tags = ["Bank reconciliation"];
const lineParams = uuidParam.extend({ lineId: z.uuid() });

export const bankReconciliationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { schema: { tags, summary: "List bank statements" } }, async (req) => {
    const ctx = requireOrg(req, "reports.view");
    return { data: await statements(app.db, ctx.organizationId) };
  });
  app.post("/import", {
    // A full statement can contain 1,000 UTF-8 or JSON-escaped bank descriptions.
    bodyLimit: 4 * 1024 * 1024,
    schema: { tags, summary: "Import a complete bank statement", body: importBody },
  }, async (req, reply) => {
    const ctx = requireOrg(req, "bank.reconcile");
    const result = await app.db.transaction((tx) => importStatement(tx, ctx, req.body));
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });
  app.get("/:id", { schema: { tags, params: uuidParam, summary: "Get bank transactions and outstanding ledger postings" } }, async (req) => {
    const ctx = requireOrg(req, "reports.view");
    return app.db.transaction(async (tx) => {
      const statement = await getStatement(tx, ctx.organizationId, req.params.id);
      return statementDetail(tx, ctx.organizationId, statement);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
  app.post("/:id/lines/:lineId/match", {
    schema: { tags, params: lineParams, body: z.object({ journalLineId: z.uuid() }), summary: "Match a bank transaction to a posting" },
  }, async (req) => {
    const ctx = requireOrg(req, "bank.reconcile");
    return app.db.transaction((tx) => changeMatch(tx, ctx, req.params.id, req.params.lineId, req.body.journalLineId));
  });
  app.post("/:id/lines/:lineId/unmatch", {
    schema: { tags, params: lineParams, body: z.object({ expectedJournalLineId: z.uuid().optional() }).nullish(), summary: "Remove a bank transaction match" },
  }, async (req) => {
    const ctx = requireOrg(req, "bank.reconcile");
    return app.db.transaction((tx) => changeMatch(tx, ctx, req.params.id, req.params.lineId, null, req.body?.expectedJournalLineId));
  });
  app.post("/:id/close", { schema: { tags, params: uuidParam, summary: "Close a balanced bank statement" } }, async (req) => {
    const ctx = requireOrg(req, "bank.reconcile");
    return app.db.transaction((tx) => setClosed(tx, ctx, req.params.id, true));
  });
  app.post("/:id/reopen", { schema: { tags, params: uuidParam, summary: "Reopen a bank statement" } }, async (req) => {
    const ctx = requireOrg(req, "bank.reopen");
    return app.db.transaction((tx) => setClosed(tx, ctx, req.params.id, false));
  });
  app.delete("/:id", { schema: { tags, params: uuidParam, summary: "Discard the latest open statement after removing all matches" } }, async (req) => {
    const ctx = requireOrg(req, "bank.reconcile");
    return app.db.transaction((tx) => discard(tx, ctx, req.params.id));
  });
};
