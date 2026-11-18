import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

export function Card({ className, children, ...props }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-lg border border-border bg-bg shadow-card", className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ title, action, description }: { title: ReactNode; action?: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-[13px] text-muted">{breadcrumb}</div>}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-surface-2 text-fg",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", badgeTones[tone])}>{children}</span>;
}

const STATUS: Record<string, { label: string; tone: keyof typeof badgeTones }> = {
  draft: { label: "Draft", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "info" },
  invoiced: { label: "Invoiced", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  open: { label: "Open", tone: "info" },
  partially_paid: { label: "Partially paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  void: { label: "Void", tone: "neutral" },
  overdue: { label: "Overdue", tone: "danger" },
  issued: { label: "Issued", tone: "info" },
  partially_received: { label: "Partially received", tone: "warning" },
  received: { label: "Received", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
  posted: { label: "Posted", tone: "success" },
};

export function StatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  const s = overdue && (status === "open" || status === "partially_paid") ? STATUS.overdue! : (STATUS[status] ?? { label: status, tone: "neutral" as const });
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Money({ value, className, strong }: { value: string | number | null | undefined; className?: string; strong?: boolean }) {
  const negative = Number(value ?? 0) < 0;
  return <span className={cn("tabular whitespace-nowrap", negative && "text-danger", strong && "font-semibold", className)}>{money(value)}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} aria-hidden />;
}

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 rounded-full bg-surface-2 p-3 text-muted [&_svg]:size-5">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="font-medium text-danger">We couldn’t load this.</p>
      <p className="text-sm text-muted">{error instanceof Error ? error.message : "Please try again."}</p>
      {retry && (
        <button className="text-sm text-accent underline" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function DescriptionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs text-muted">{i.label}</dt>
          <dd className="truncate text-sm">{i.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[11px] text-muted">{children}</kbd>;
}
