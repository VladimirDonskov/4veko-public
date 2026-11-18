import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://veko:veko_dev_password@localhost:5433/veko"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.string().default("development"),
  // The Java VekoScript platform (backend/). This API signs short-lived tokens for it with the
  // shared secret; without a secret the /platform gateway answers 503.
  VKS_PLATFORM_URL: z.string().url().default("http://localhost:8090"),
  VKS_JWT_SECRET: z.string().min(32).optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
