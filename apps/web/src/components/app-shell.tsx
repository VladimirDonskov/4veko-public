"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Code2, Database, FileCode2, Layers, LogOut, Menu, Moon, Search, Sun, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldLabel, useConfig } from "@/lib/config";
import { useMe } from "@/lib/session";
import { CommandPalette } from "./command-palette";
import { NAV } from "./nav";
import { ErrorState, Kbd, Skeleton } from "./ui/misc";

export function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
        <rect width="24" height="24" rx="6" fill="var(--accent)" />
        <path d="M6 7l4.2 10L12 12.6 13.8 17 18 7" fill="none" stroke="var(--on-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      4VEKO
    </span>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("veko-theme", next ? "dark" : "light");
    } catch {
      /* preference lasts for this page only */
    }
  }
  return (
    <button onClick={toggle} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={dark ? "Use light theme" : "Use dark theme"}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const config = useConfig();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // A lapsed session sends the user to sign in once; the page underneath is
  // not rendered, so it cannot fire its own (failing) requests meanwhile.
  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  const redirected = useRef(false);
  useEffect(() => {
    if (unauthorized && !redirected.current) {
      redirected.current = true;
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [unauthorized, router]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setNavOpen(false), [pathname]);

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    qc.clear();
    router.replace("/login");
  }

  const perms = me.data?.permissions ?? [];
  // Objects declared in the organization's Veko configuration get their own section.
  const meta = config.data?.metadata;
  const configSection: (typeof NAV)[number] = {
    section: "Configuration",
    items: [
      { label: "Configurator", href: "/configurator", icon: Code2 },
      ...(meta?.catalogs ?? []).map((c) => ({ label: fieldLabel(c.name), href: `/x/${c.name}`, icon: Database })),
      ...(meta?.documents ?? []).map((d) => ({ label: fieldLabel(d.name), href: `/x/${d.name}`, icon: FileCode2 })),
      ...(meta?.registers ?? []).map((r) => ({ label: fieldLabel(r.name), href: `/x/registers/${r.name}`, icon: Layers })),
    ],
  };
  const sections = [...NAV.slice(0, -1), configSection, NAV[NAV.length - 1]!];
  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {sections.map((section) => {
        const items = section.items.filter((i) => !i.permission || perms.includes(i.permission));
        if (items.length === 0) return null;
        return (
          <div key={section.section}>
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{section.section}</p>
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg",
                        active && "bg-accent-soft font-medium text-accent hover:bg-accent-soft hover:text-accent",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-bg focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center border-b border-border px-5">
          <Logo />
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-border p-3 text-xs text-muted">
          {me.data ? (
            <>
              <p className="truncate font-medium text-fg">{me.data.organization?.name}</p>
              <p className="truncate">
                {me.data.user.name} · {me.data.role}
              </p>
            </>
          ) : (
            <Skeleton className="h-8" />
          )}
        </div>
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-surface shadow-pop">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <Logo />
              <button onClick={() => setNavOpen(false)} aria-label="Close menu" className="rounded-md p-2 hover:bg-surface-2">
                <X className="size-4" />
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-bg/90 px-4 backdrop-blur">
          <button className="rounded-md p-2 hover:bg-surface-2 lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Menu className="size-4" />
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 flex-1 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm text-muted hover:border-border-input sm:max-w-md"
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 truncate text-left">Search or jump to…</span>
            <span className="hidden sm:inline">
              <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
            </span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <button onClick={signOut} className="flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
          {me.isLoading || unauthorized ? (
            <Skeleton className="h-40" />
          ) : me.error ? (
            <ErrorState error={me.error} retry={() => me.refetch()} />
          ) : (
            children
          )}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
