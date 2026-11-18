"use client";

import { useSearchParams } from "next/navigation";

/** Keep the business date when a report is bookmarked or reopened from a drill-down. */
export function useDateFilter(key: string, fallback: string) {
  const params = useSearchParams();
  const raw = params.get(key) ?? fallback;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
  function setValue(next: string) {
    const url = new URL(window.location.href);
    url.searchParams.set(key, next);
    window.history.replaceState(null, "", url);
  }
  return [value, setValue] as const;
}
