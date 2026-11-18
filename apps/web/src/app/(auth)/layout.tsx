import type { ReactNode } from "react";
import { Logo, ThemeToggle } from "@/components/app-shell";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-14 items-center justify-between px-6">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-[8vh]">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
