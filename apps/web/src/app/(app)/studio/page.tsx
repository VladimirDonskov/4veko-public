"use client";

import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { usePlatformApps } from "@/lib/platform";
import { dateTime } from "@/lib/format";

export default function StudioPage() {
  const apps = usePlatformApps();
  const manage = apps.data?.you.roles.includes("admin");
  return (
    <>
      <PageHeader title="4VEKO Studio" description="VekoScript applications for this organization."
        actions={manage && <ButtonLink href="/studio/new">New application</ButtonLink>} />
      <Card>
        {apps.isPending && <LoadingRows />}
        {apps.isError && <ErrorState error={apps.error} retry={() => apps.refetch()} />}
        {apps.data?.applications.length === 0 && <EmptyState title="No applications published" description={manage ? "Create an application to define its objects and business logic." : undefined} />}
        {apps.data?.applications.map(app => (
          <Link key={app.name} href={`/studio/app/${app.name}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-surface">
            <span className="flex items-center gap-3"><span className="font-medium">{app.name}</span><Badge>Version {app.version}</Badge></span>
            <span className="text-xs text-muted">{app.deployedBy} · {dateTime(app.deployedAt)}</span>
          </Link>
        ))}
      </Card>
    </>
  );
}
