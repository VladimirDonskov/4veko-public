import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireOrg } from "../../lib/context";
import { today } from "../../lib/dates";
import { isoDate, optionalText, uuidParam } from "../../lib/validation";
import { baselineStatement, depositHeader, depositHeaders, depositReceipts, eligibleReceipts, matchedStatement } from "./queries";
import { postDeposit, voidDeposit } from "./service";

const tags = ["Bank deposits"];
const uuid = z.uuid().toLowerCase();
const textOk = (s: string | null) => !s?.includes("\0");
const newDeposit = z.object({
  bankAccountId: uuid, date: isoDate, paymentIds: z.array(uuid).min(1).max(500),
  memo: optionalText(500).refine(textOk, "Enter a valid memo."),
});

export const depositRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { schema: { tags, summary: "List bank deposits" } }, async req => {
    const ctx = requireOrg(req, "reports.view");
    return { data: await depositHeaders(app.db, ctx.organizationId) };
  });
  app.get("/eligible", {
    schema: { tags, summary: "Find posted receipts available for a new deposit on a date", querystring: z.object({ asOf: isoDate.optional() }) },
  }, async req => {
    const ctx = requireOrg(req, "reports.view");
    return { data: await eligibleReceipts(app.db, ctx.organizationId, req.query.asOf ?? today()) };
  });
  app.get("/:id", { schema: { tags, summary: "Deposit and its original customer receipts", params: uuidParam } }, async req => {
    const ctx = requireOrg(req, "reports.view");
    return app.db.transaction(async tx => {
      const header = await depositHeader(tx, ctx.organizationId, req.params.id);
      return {
        ...header, receipts: await depositReceipts(tx, ctx.organizationId, header.id),
        matchedStatementId: await matchedStatement(tx, ctx.organizationId, header.journalEntryId),
        baselineStatementId: await baselineStatement(tx, ctx.organizationId, header),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
  app.post("/", {
    schema: {
      tags, summary: "Post a deposit from Undeposited Funds", body: newDeposit,
      headers: z.object({ "idempotency-key": z.string().trim().min(8).max(100).refine(textOk, "Enter a valid idempotency key.") }),
    },
  }, async (req, reply) => {
    const ctx = requireOrg(req, "bank.reconcile");
    const result = await app.db.transaction(tx => postDeposit(tx, ctx, req.body, req.headers["idempotency-key"]));
    return reply.status(result.replayed ? 200 : 201).header("Idempotent-Replayed", String(result.replayed)).send(result.header);
  });
  app.post("/:id/void", {
    schema: {
      tags, summary: "Void an unmatched deposit and release its receipts", params: uuidParam,
      body: z.object({ date: isoDate, reason: z.string().trim().min(1).max(500).refine(textOk, "Enter a valid reason.") }),
    },
  }, async req => {
    const ctx = requireOrg(req, "bank.reconcile");
    return app.db.transaction(tx => voidDeposit(tx, ctx, req.params.id, req.body.date, req.body.reason));
  });
};
