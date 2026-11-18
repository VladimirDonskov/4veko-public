import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { organizations } from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { invalid } from "../../lib/errors";
import { fiscalYearStart, today } from "../../lib/dates";
import { isoDate } from "../../lib/validation";
import { apAging, arAging, balanceSheet, controlReconciliation, profitAndLoss, trialBalance } from "./queries";

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/trial-balance",
    { schema: { tags: ["Reports"], summary: "Trial balance", querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => {
      const ctx = requireOrg(req, "reports.view");
      return trialBalance(app.db, ctx.organizationId, req.query.asOf ?? today());
    },
  );

  app.get(
    "/profit-and-loss",
    {
      schema: {
        tags: ["Reports"],
        summary: "Profit and Loss (income statement). Defaults to this fiscal year to date.",
        querystring: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "reports.view");
      const to = req.query.to ?? today();
      let from = req.query.from;
      if (!from) {
        const [org] = await app.db
          .select({ fy: organizations.fiscalYearStartMonth })
          .from(organizations)
          .where(eq(organizations.id, ctx.organizationId));
        from = fiscalYearStart(to, org?.fy ?? 1);
      }
      if (from > to) throw invalid("The start date must be on or before the end date.");
      return profitAndLoss(app.db, ctx.organizationId, from, to);
    },
  );

  app.get(
    "/balance-sheet",
    { schema: { tags: ["Reports"], summary: "Balance sheet", querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => {
      const ctx = requireOrg(req, "reports.view");
      return balanceSheet(app.db, ctx.organizationId, req.query.asOf ?? today());
    },
  );

  app.get(
    "/ar-aging",
    { schema: { tags: ["Reports"], summary: "Accounts receivable aging by customer", querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => {
      const ctx = requireOrg(req, "reports.view");
      return arAging(app.db, ctx.organizationId, req.query.asOf ?? today());
    },
  );

  app.get(
    "/ap-aging",
    { schema: { tags: ["Reports"], summary: "Accounts payable aging by vendor", querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => {
      const ctx = requireOrg(req, "reports.view");
      return apAging(app.db, ctx.organizationId, req.query.asOf ?? today());
    },
  );

  app.get(
    "/control-reconciliation",
    { schema: { tags: ["Reports"], summary: "Reconcile receivables and payables to their General Ledger control accounts", querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => {
      const ctx = requireOrg(req, "reports.view");
      return controlReconciliation(app.db, ctx.organizationId, req.query.asOf ?? today());
    },
  );
};
