"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { PoForm } from "../po-form";

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/purchase-orders" className="hover:underline">Purchase Orders</Link>}
        title="New purchase order"
        description="Order stocked items from a vendor. Receiving the goods adds them to stock; the vendor's bill comes after."
      />
      <Suspense>
        <PoForm
          onSubmit={async (body) => {
            const po = await api<{ id: string; number: string }>("/purchase-orders", { method: "POST", body });
            qc.invalidateQueries({ queryKey: ["purchase-orders"] });
            toast.success(`Saved draft ${po.number}.`);
            router.push(`/purchase-orders/${po.id}`);
          }}
        />
      </Suspense>
    </>
  );
}
