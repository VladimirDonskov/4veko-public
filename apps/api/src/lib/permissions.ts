export const ROLES = ["owner", "admin", "accountant", "sales", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "org.manage"
  | "members.manage"
  | "masterdata.write"
  | "accounts.write"
  | "journal.post"
  | "sales.write"
  | "invoice.post"
  | "invoice.void"
  | "payments.write"
  | "inventory.adjust"
  | "purchasing.write"
  | "bills.post"
  | "bills.pay"
  | "config.manage"
  | "reports.view"
  | "audit.view";

const ALL: Permission[] = [
  "org.manage",
  "members.manage",
  "masterdata.write",
  "accounts.write",
  "journal.post",
  "sales.write",
  "invoice.post",
  "invoice.void",
  "payments.write",
  "inventory.adjust",
  "purchasing.write",
  "bills.post",
  "bills.pay",
  "config.manage",
  "reports.view",
  "audit.view",
];

// Reading business records is allowed for every member; this map covers changes
// and sensitive views. Custom roles are planned (see docs/product/roadmap.md).
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(ALL),
  admin: new Set(ALL),
  accountant: new Set<Permission>([
    "masterdata.write",
    "accounts.write",
    "journal.post",
    "sales.write",
    "invoice.post",
    "invoice.void",
    "payments.write",
    "inventory.adjust",
    "purchasing.write",
    "bills.post",
    "bills.pay",
    "reports.view",
    "audit.view",
  ]),
  sales: new Set<Permission>(["masterdata.write", "sales.write", "invoice.post", "reports.view"]),
  viewer: new Set<Permission>(["reports.view"]),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
