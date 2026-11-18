"use client";

import { StudioEditor } from "@/components/platform/studio-editor";
import { ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { usePlatformApps } from "@/lib/platform";

export default function NewApplicationPage() {
  const apps = usePlatformApps();
  if (apps.isPending) return <LoadingRows />;
  if (apps.isError) return <ErrorState error={apps.error} retry={() => apps.refetch()} />;
  if (!apps.data.you.roles.includes("admin")) return <PageHeader title="Application publishing" description="An organization owner or administrator can create applications." />;
  return <StudioEditor initial={{ name: "", version: 0, source: "" }} />;
}
