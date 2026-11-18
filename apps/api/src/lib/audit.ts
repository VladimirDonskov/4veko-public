import type { DbOrTx } from "../db/client";
import { auditEvents } from "../db/schema";

export type AuditInput = {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
  ip?: string | null;
};

/** Append-only. Call inside the same transaction as the change it records. */
export async function audit(db: DbOrTx, input: AuditInput) {
  await db.insert(auditEvents).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    data: input.data ?? null,
    ip: input.ip ?? null,
  });
}
