import {
  BookOpen,
  Boxes,
  ClipboardList,
  Code2,
  CreditCard,
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  Landmark,
  Library,
  Package,
  PieChart,
  Receipt,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { label: string; href: string; icon: LucideIcon; permission?: string };

export const NAV: { section: string; items: NavItem[] }[] = [
  { section: "Overview", items: [{ label: "Dashboard", href: "/dashboard", icon: LayoutDashboard }] },
  {
    section: "Sales",
    items: [
      { label: "Customers", href: "/customers", icon: Users },
      { label: "Sales Orders", href: "/sales-orders", icon: ClipboardList },
      { label: "Invoices", href: "/invoices", icon: FileText },
      { label: "Payments", href: "/payments", icon: CreditCard },
    ],
  },
  {
    section: "Purchasing",
    items: [
      { label: "Vendors", href: "/vendors", icon: Truck },
      { label: "Purchase Orders", href: "/purchase-orders", icon: ShoppingCart },
      { label: "Bills", href: "/bills", icon: Receipt },
      { label: "Bill Payments", href: "/bill-payments", icon: Wallet },
    ],
  },
  {
    section: "Inventory",
    items: [
      { label: "Products & Services", href: "/items", icon: Package },
      { label: "Stock", href: "/inventory", icon: Boxes },
    ],
  },
  {
    section: "Accounting",
    items: [
      { label: "Chart of Accounts", href: "/accounts", icon: Library },
      { label: "Journal Entries", href: "/journal", icon: BookOpen },
      { label: "Bank Deposits", href: "/deposits", icon: Inbox, permission: "reports.view" },
      { label: "Bank Reconciliation", href: "/bank-reconciliations", icon: Landmark, permission: "reports.view" },
      { label: "Reports", href: "/reports", icon: PieChart, permission: "reports.view" },
    ],
  },
  {
    section: "Admin",
    items: [
      { label: "Settings", href: "/settings", icon: Settings },
      { label: "Studio", href: "/studio", icon: Code2 },
      { label: "Audit Log", href: "/audit", icon: History, permission: "audit.view" },
    ],
  },
];

/** Link to the document behind a journal entry or stock move, including configured documents ("Rental-1001"). */
export function sourceHref(sourceType: string, sourceId: string | null, sourceNumber: string | null): string | null {
  if (!sourceId) return null;
  if (sourceType === "config_document") {
    const type = sourceNumber?.replace(/-\d+$/, "");
    return type ? `/x/${type}/${sourceId}` : null;
  }
  return DOC_ROUTE[sourceType] ? `${DOC_ROUTE[sourceType]}/${sourceId}` : null;
}

/** Where each document type lives in the app, for links from search, ledgers and stock history. */
export const DOC_ROUTE: Record<string, string> = {
  customer: "/customers",
  vendor: "/vendors",
  item: "/items",
  invoice: "/invoices",
  invoice_void: "/invoices",
  sales_order: "/sales-orders",
  payment: "/payments",
  deposit: "/deposits",
  deposit_void: "/deposits",
  account: "/accounts",
  purchase_order: "/purchase-orders",
  bill: "/bills",
  bill_void: "/bills",
  bill_payment: "/bill-payments",
};
