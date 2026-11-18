export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} was not found.`);
export const forbidden = (message = "You do not have permission to do this.") => new AppError(403, "forbidden", message);
export const unauthorized = () => new AppError(401, "unauthorized", "Please sign in to continue.");
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(409, "conflict", message, details);
export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, "business_rule", message, details);

type PgError = { code?: string; constraint?: string; message?: string; detail?: string };

const CONSTRAINT_MESSAGES: Record<string, string> = {
  users_email_lower_uq: "An account with this email already exists.",
  accounts_org_number_uq: "An account with this number already exists.",
  accounts_org_system_key_uq: "This system account already exists.",
  parties_org_kind_name_uq: "A record with this name already exists.",
  items_org_sku_uq: "An item with this SKU already exists.",
  inv_sales_order_active_uq: "This sales order has already been invoiced.",
  memberships_org_user_uq: "This person is already a member of the organization.",
  stock_nonneg_ck: "There is not enough stock on hand for this transaction.",
  inv_amounts_ck: "The payment would exceed the invoice balance.",
  bill_vendor_ref_active_uq: "This vendor invoice number has already been entered for this vendor.",
  bill_amounts_ck: "The payment would exceed the bill balance.",
  pol_qty_ck: "That would receive more than was ordered, or bill more than was received.",
  po_org_number_uq: "A purchase order with this number already exists.",
};

/** Translate database errors (constraints, ledger triggers) into API errors. */
export function fromDatabaseError(err: unknown): AppError | null {
  const pgErr = findPgError(err);
  if (!pgErr?.code) return null;
  const message = pgErr.message ?? "Database rule violated.";
  switch (pgErr.code) {
    case "VK001":
      return new AppError(409, "immutable_record", message);
    case "VK002":
      return new AppError(422, "unbalanced_entry", message);
    case "VK003":
      return new AppError(422, "period_closed", message);
    case "23505":
      return conflict(CONSTRAINT_MESSAGES[pgErr.constraint ?? ""] ?? "This record already exists.", {
        constraint: pgErr.constraint,
      });
    case "23514":
      return invalid(CONSTRAINT_MESSAGES[pgErr.constraint ?? ""] ?? "A value is outside the allowed range.", {
        constraint: pgErr.constraint,
      });
    case "23503":
      return invalid("A referenced record does not exist in this organization.", { constraint: pgErr.constraint });
    case "40P01":
    case "40001":
      return new AppError(409, "concurrent_update", "Another change was saved at the same time. Please retry.");
    default:
      return null;
  }
}

function findPgError(err: unknown): PgError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as PgError & { cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return null;
}
