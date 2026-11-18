import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { resolveSession, SESSION_COOKIE } from "./lib/context";
import { AppError, fromDatabaseError } from "./lib/errors";
import { accountRoutes } from "./modules/accounts/routes";
import { auditRoutes } from "./modules/audit/routes";
import { authRoutes } from "./modules/auth/routes";
import { bankReconciliationRoutes } from "./modules/bank-reconciliation/routes";
import { dashboardRoutes } from "./modules/dashboard/routes";
import { depositRoutes } from "./modules/deposits/routes";
import { inventoryRoutes } from "./modules/inventory/routes";
import { itemRoutes } from "./modules/items/routes";
import { journalRoutes } from "./modules/ledger/routes";
import { orgRoutes } from "./modules/org/routes";
import { configRoutes, objectRoutes, registerRoutes } from "./modules/config/routes";
import { partyRoutes } from "./modules/parties/routes";
import { platformRoutes } from "./modules/platform/routes";
import { billPaymentRoutes, billRoutes, purchaseOrderRoutes } from "./modules/purchasing/routes";
import { reportRoutes } from "./modules/reports/routes";
import { invoiceRoutes } from "./modules/sales/invoice-routes";
import { paymentRoutes } from "./modules/sales/payment-routes";
import { salesOrderRoutes } from "./modules/sales/order-routes";
import { searchRoutes } from "./modules/search/routes";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(opts: { config: Config; db: Db; logger?: boolean }) {
  const { config, db } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
          },
    trustProxy: true,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("db", db);
  app.decorate("config", config);
  app.decorateRequest("auth", null);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "4VEKO API",
        version: "0.1.0",
        description:
          "REST API for 4VEKO: organizations, master data, General Ledger, sales, payments and inventory. " +
          "Authenticate with the session cookie returned by POST /api/v1/auth/login.",
      },
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });

  // CSRF defence in depth: cookies are SameSite=Lax, and state-changing
  // requests from a browser must come from the web app's origin.
  const allowedOrigins = new Set([config.WEB_ORIGIN, `http://localhost:${config.PORT}`]);
  app.addHook("onRequest", async (req) => {
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        throw new AppError(403, "bad_origin", "Request origin is not allowed.");
      }
    }
    req.auth = await resolveSession(db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: "validation_error",
          message: "Some fields are missing or invalid.",
          details: {
            issues: err.validation.map((v) => ({
              path:
                v.instancePath.replace(/^\//, "").replaceAll("/", ".") ||
                (v.params as { issue?: { path?: PropertyKey[] } } | undefined)?.issue?.path?.map(String).join(".") ||
                "",
              message: v.message,
            })),
          },
        },
      });
    }
    const dbError = fromDatabaseError(err);
    if (dbError) {
      return reply
        .status(dbError.status)
        .send({ error: { code: dbError.code, message: dbError.message, details: dbError.details } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply
      .status(500)
      .send({ error: { code: "internal_error", message: "Something went wrong on our side. Please try again." } });
  });

  app.get("/api/health", { schema: { hide: true } }, async () => {
    await db.execute("select 1");
    return { status: "ok" };
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: "/auth" });
      await v1.register(orgRoutes, { prefix: "/org" });
      await v1.register(partyRoutes);
      await v1.register(itemRoutes, { prefix: "/items" });
      await v1.register(accountRoutes, { prefix: "/accounts" });
      await v1.register(bankReconciliationRoutes, { prefix: "/bank-reconciliations" });
      await v1.register(depositRoutes, { prefix: "/deposits" });
      await v1.register(journalRoutes, { prefix: "/journal-entries" });
      await v1.register(salesOrderRoutes, { prefix: "/sales-orders" });
      await v1.register(invoiceRoutes, { prefix: "/invoices" });
      await v1.register(paymentRoutes, { prefix: "/payments" });
      await v1.register(inventoryRoutes, { prefix: "/inventory" });
      await v1.register(purchaseOrderRoutes, { prefix: "/purchase-orders" });
      await v1.register(billRoutes, { prefix: "/bills" });
      await v1.register(billPaymentRoutes, { prefix: "/bill-payments" });
      await v1.register(configRoutes, { prefix: "/config" });
      await v1.register(objectRoutes, { prefix: "/x" });
      await v1.register(registerRoutes, { prefix: "/registers" });
      await v1.register(reportRoutes, { prefix: "/reports" });
      await v1.register(dashboardRoutes, { prefix: "/dashboard" });
      await v1.register(auditRoutes, { prefix: "/audit-events" });
      await v1.register(searchRoutes, { prefix: "/search" });
      await v1.register(platformRoutes, { prefix: "/platform" });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
