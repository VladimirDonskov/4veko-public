"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense } from "react";
import { DocumentForm } from "@/components/document-form";
import { PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";

export default function NewInvoicePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/invoices" className="hover:underline">Invoices</Link>}
        title="New invoice"
        description="Posting records the sale, the receivable, sales tax and the stock shipped in one step."
      />
      <Suspense>
        <DocumentForm
          mode="invoice"
          onSubmit={async (body) => {
            const invoice = await api<{ id: string; number: string }>("/invoices", { method: "POST", body });
            qc.invalidateQueries();
            toast.success(`Invoice ${invoice.number} posted.`);
            router.push(`/invoices/${invoice.id}`);
          }}
        />
      </Suspense>
    </>
  );
}
