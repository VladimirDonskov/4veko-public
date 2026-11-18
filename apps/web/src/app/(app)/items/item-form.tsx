"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/inputs";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";

export type Item = {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  type: "inventory" | "non_inventory" | "service";
  unit: string;
  salesPrice: string;
  purchaseCost: string;
  taxable: boolean;
  reorderPoint: string | null;
  incomeAccountId?: string;
  isActive: boolean;
  qtyOnHand: string;
  valueOnHand: string;
};

type Account = { id: string; number: string; name: string; type: string };

export const ITEM_TYPES = { inventory: "Stocked product", non_inventory: "Non-stocked product", service: "Service" } as const;

export function ItemForm({ item, open, onOpenChange, onSaved }: { item?: Item; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: (i: Item) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<Item["type"]>(item?.type ?? "inventory");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts"), enabled: open });
  const save = useMutation({
    mutationFn: (body: unknown) => (item ? api<Item>(`/items/${item.id}`, { method: "PATCH", body }) : api<Item>("/items", { method: "POST", body })),
    onSuccess: (i) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(`${item ? "Updated" : "Created"} ${i.sku}`);
      onOpenChange(false);
      onSaved?.(i);
    },
    onError: (err) => err instanceof ApiError && setErrors(err.fieldErrors()),
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const f = new FormData(e.currentTarget);
    save.mutate({
      sku: f.get("sku"),
      name: f.get("name"),
      type,
      unit: f.get("unit") || "ea",
      salesPrice: f.get("salesPrice") || "0",
      purchaseCost: f.get("purchaseCost") || "0",
      taxable: f.get("taxable") === "on",
      description: f.get("description") || null,
      incomeAccountId: f.get("incomeAccountId") || undefined,
      reorderPoint: type === "inventory" && f.get("reorderPoint") ? f.get("reorderPoint") : null,
    });
  }

  const revenueAccounts = (accounts.data?.data ?? []).filter((a) => a.type === "revenue");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? `Edit ${item.sku}` : "New product or service"}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="item-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="item-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormError message={save.error instanceof ApiError && !Object.keys(errors).length ? save.error.message : null} />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Type</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(Object.keys(ITEM_TYPES) as Item["type"][]).map((t) => (
              <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${type === t ? "border-accent bg-accent-soft" : "border-border"}`}>
                <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} disabled={!!item && item.type !== t && Number(item.qtyOnHand) !== 0} />
                {ITEM_TYPES[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="SKU" required error={errors.sku}>
          {(p) => <Input {...p} name="sku" defaultValue={item?.sku} autoFocus={!item} />}
        </Field>
        <Field label="Unit" error={errors.unit} hint="e.g. ea, case, hr">
          {(p) => <Input {...p} name="unit" defaultValue={item?.unit ?? (type === "service" ? "hr" : "ea")} />}
        </Field>
        <Field label="Name" required error={errors.name} className="sm:col-span-2">
          {(p) => <Input {...p} name="name" defaultValue={item?.name} />}
        </Field>
        <Field label="Sales price" error={errors.salesPrice}>
          {(p) => <Input {...p} name="salesPrice" inputMode="decimal" defaultValue={item?.salesPrice ?? ""} placeholder="0.00" />}
        </Field>
        <Field label={type === "service" ? "Cost (for reference)" : "Purchase cost"} error={errors.purchaseCost}>
          {(p) => <Input {...p} name="purchaseCost" inputMode="decimal" defaultValue={item?.purchaseCost ?? ""} placeholder="0.00" />}
        </Field>
        {type === "inventory" && (
          <Field label="Reorder point" error={errors.reorderPoint} hint="Flag as low stock at or below this quantity.">
            {(p) => <Input {...p} name="reorderPoint" inputMode="decimal" defaultValue={item?.reorderPoint ?? ""} />}
          </Field>
        )}
        <Field label="Income account" hint="Where sales of this item are recorded.">
          {(p) => (
            <Select {...p} name="incomeAccountId" defaultValue={item?.incomeAccountId ?? ""}>
              <option value="">Default for this type</option>
              {revenueAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="taxable" defaultChecked={item?.taxable ?? type !== "service"} key={type} /> Charge sales tax on this item
        </label>
        <Field label="Description" className="sm:col-span-2">
          {(p) => <Textarea {...p} name="description" defaultValue={item?.description ?? ""} />}
        </Field>
      </form>
    </Dialog>
  );
}
