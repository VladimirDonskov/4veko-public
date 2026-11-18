import type { Tx } from "../../db/client";
import { accounts, locations, memberships, organizations } from "../../db/schema";
import { audit } from "../../lib/audit";
import { US_SMALL_BUSINESS_CHART } from "../accounts/chart-template";

export type NewOrganization = {
  name: string;
  fiscalYearStartMonth?: number;
  defaultTaxRate?: string;
};

/** Creates an organization with its owner, US chart of accounts and default warehouse. */
export async function createOrganization(tx: Tx, ownerUserId: string, input: NewOrganization) {
  const [org] = await tx
    .insert(organizations)
    .values({
      name: input.name,
      fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
      defaultTaxRate: input.defaultTaxRate ?? "0",
    })
    .returning();
  if (!org) throw new Error("Organization insert returned nothing");

  await tx.insert(memberships).values({ organizationId: org.id, userId: ownerUserId, role: "owner" });
  await tx.insert(accounts).values(
    US_SMALL_BUSINESS_CHART.map((a) => ({
      organizationId: org.id,
      number: a.number,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      systemKey: a.systemKey ?? null,
      description: a.description ?? null,
    })),
  );
  await tx.insert(locations).values({ organizationId: org.id, code: "MAIN", name: "Main Warehouse", isDefault: true });
  await audit(tx, {
    organizationId: org.id,
    actorUserId: ownerUserId,
    action: "organization.created",
    entityType: "organization",
    entityId: org.id,
    summary: `Created organization ${org.name}`,
  });
  return org;
}
