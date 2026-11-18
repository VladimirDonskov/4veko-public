"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Card } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function SignupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    setError(null);
    setFields({});
    try {
      await api("/auth/signup", {
        method: "POST",
        body: {
          name: f.get("name"),
          email: f.get("email"),
          password: f.get("password"),
          organizationName: f.get("organizationName"),
          fiscalYearStartMonth: Number(f.get("fiscalYearStartMonth")),
        },
      });
      qc.clear();
      router.replace("/dashboard?welcome=1");
    } catch (err) {
      if (err instanceof ApiError) {
        setFields(err.fieldErrors());
        setError(err.message);
      } else setError("Could not create your account. Please try again.");
      setLoading(false);
    }
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold">Create your company</h1>
      <p className="mt-1 text-sm text-muted">You get a US chart of accounts and a main warehouse, ready to use.</p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <FormError message={error} />
        <Field label="Your name" required error={fields.name}>
          {(p) => <Input {...p} name="name" autoComplete="name" autoFocus />}
        </Field>
        <Field label="Work email" required error={fields.email}>
          {(p) => <Input {...p} name="email" type="email" autoComplete="email" />}
        </Field>
        <Field label="Password" required error={fields.password} hint="At least 10 characters.">
          {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" minLength={10} />}
        </Field>
        <Field label="Company name" required error={fields.organizationName}>
          {(p) => <Input {...p} name="organizationName" autoComplete="organization" />}
        </Field>
        <Field label="Fiscal year starts in">
          {(p) => (
            <Select {...p} name="fiscalYearStartMonth" defaultValue="1">
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" loading={loading} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
