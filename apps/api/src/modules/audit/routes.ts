import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auditEvents, users } from "../../db/schema";
import { requireOrg } from "../../lib/context";

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Audit"],
        summary: "Audit history (newest first)",
        querystring: z.object({
          entityType: z.string().max(60).optional(),
          entityId: z.string().max(60).optional(),
          before: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "audit.view");
      const { entityType, entityId, before, limit } = req.query;
      const rows = await app.db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          entityType: auditEvents.entityType,
          entityId: auditEvents.entityId,
          summary: auditEvents.summary,
          data: auditEvents.data,
          ip: auditEvents.ip,
          actorName: users.name,
          actorEmail: users.email,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(
          and(
            eq(auditEvents.organizationId, ctx.organizationId),
            entityType ? eq(auditEvents.entityType, entityType) : undefined,
            entityId ? eq(auditEvents.entityId, entityId) : undefined,
            before ? lt(auditEvents.id, before) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(limit);
      return { data: rows, nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null };
    },
  );
};
