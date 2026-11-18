// A US small-business chart of accounts, written from common US practice.
// Account numbers follow the usual 1xxx assets ... 8xxx other expenses layout.

export const ACCOUNT_SUBTYPES = {
  asset: ["bank", "cash", "accounts_receivable", "inventory", "other_current_asset", "fixed_asset", "other_asset"],
  liability: ["accounts_payable", "credit_card", "other_current_liability", "long_term_liability"],
  equity: ["equity"],
  revenue: ["sales", "other_income"],
  expense: ["cogs", "operating_expense", "other_expense"],
} as const;

export type AccountType = keyof typeof ACCOUNT_SUBTYPES;

export const SYSTEM_KEYS = [
  "cash_operating",
  "undeposited_funds",
  "accounts_receivable",
  "inventory",
  "accounts_payable",
  "sales_tax_payable",
  "opening_balance_equity",
  "retained_earnings",
  "sales_revenue",
  "service_revenue",
  "cogs",
  "inventory_shrinkage",
  "received_not_billed",
  "purchase_price_variance",
] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

type TemplateAccount = {
  number: string;
  name: string;
  type: AccountType;
  subtype: string;
  systemKey?: SystemKey;
  description?: string;
};

export const US_SMALL_BUSINESS_CHART: TemplateAccount[] = [
  { number: "1010", name: "Operating Checking", type: "asset", subtype: "bank", systemKey: "cash_operating" },
  { number: "1020", name: "Savings", type: "asset", subtype: "bank" },
  {
    number: "1050",
    name: "Undeposited Funds",
    type: "asset",
    subtype: "cash",
    systemKey: "undeposited_funds",
    description: "Customer payments received but not yet deposited at the bank.",
  },
  { number: "1200", name: "Accounts Receivable", type: "asset", subtype: "accounts_receivable", systemKey: "accounts_receivable" },
  { number: "1300", name: "Inventory", type: "asset", subtype: "inventory", systemKey: "inventory" },
  { number: "1400", name: "Prepaid Expenses", type: "asset", subtype: "other_current_asset" },
  { number: "1500", name: "Equipment", type: "asset", subtype: "fixed_asset" },
  { number: "1590", name: "Accumulated Depreciation", type: "asset", subtype: "fixed_asset" },
  { number: "2000", name: "Accounts Payable", type: "liability", subtype: "accounts_payable", systemKey: "accounts_payable" },
  {
    number: "2050",
    name: "Received Not Billed",
    type: "liability",
    subtype: "other_current_liability",
    systemKey: "received_not_billed",
    description: "Stock received from vendors whose bill has not been entered yet.",
  },
  { number: "2100", name: "Business Credit Card", type: "liability", subtype: "credit_card" },
  { number: "2200", name: "Sales Tax Payable", type: "liability", subtype: "other_current_liability", systemKey: "sales_tax_payable" },
  { number: "2300", name: "Accrued Liabilities", type: "liability", subtype: "other_current_liability" },
  { number: "2500", name: "Long-Term Loans", type: "liability", subtype: "long_term_liability" },
  { number: "3000", name: "Owner's Capital", type: "equity", subtype: "equity" },
  {
    number: "3100",
    name: "Opening Balance Equity",
    type: "equity",
    subtype: "equity",
    systemKey: "opening_balance_equity",
    description: "Offset for opening balances entered when you start using 4VEKO.",
  },
  { number: "3200", name: "Retained Earnings", type: "equity", subtype: "equity", systemKey: "retained_earnings" },
  { number: "4000", name: "Product Sales", type: "revenue", subtype: "sales", systemKey: "sales_revenue" },
  { number: "4100", name: "Service Revenue", type: "revenue", subtype: "sales", systemKey: "service_revenue" },
  { number: "4900", name: "Other Income", type: "revenue", subtype: "other_income" },
  { number: "5000", name: "Cost of Goods Sold", type: "expense", subtype: "cogs", systemKey: "cogs" },
  {
    number: "5100",
    name: "Inventory Shrinkage and Adjustments",
    type: "expense",
    subtype: "cogs",
    systemKey: "inventory_shrinkage",
  },
  {
    number: "5200",
    name: "Purchase Price Variance",
    type: "expense",
    subtype: "cogs",
    systemKey: "purchase_price_variance",
    description: "Difference between the purchase order cost and the vendor bill cost.",
  },
  { number: "6000", name: "Advertising and Marketing", type: "expense", subtype: "operating_expense" },
  { number: "6100", name: "Bank and Merchant Fees", type: "expense", subtype: "operating_expense" },
  { number: "6200", name: "Insurance", type: "expense", subtype: "operating_expense" },
  { number: "6300", name: "Office Supplies", type: "expense", subtype: "operating_expense" },
  { number: "6400", name: "Legal and Professional Fees", type: "expense", subtype: "operating_expense" },
  { number: "6500", name: "Rent", type: "expense", subtype: "operating_expense" },
  { number: "6600", name: "Salaries and Wages", type: "expense", subtype: "operating_expense" },
  { number: "6700", name: "Software and Subscriptions", type: "expense", subtype: "operating_expense" },
  { number: "6800", name: "Travel", type: "expense", subtype: "operating_expense" },
  { number: "6900", name: "Utilities", type: "expense", subtype: "operating_expense" },
  { number: "7000", name: "Depreciation Expense", type: "expense", subtype: "operating_expense" },
  { number: "8000", name: "Interest Expense", type: "expense", subtype: "other_expense" },
];

/** Debit-normal for assets and expenses, credit-normal for the rest. */
export function normalBalance(type: AccountType): "debit" | "credit" {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}
