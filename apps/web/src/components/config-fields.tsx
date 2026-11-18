"use client";

import { Input, Select } from "@/components/ui/inputs";
import { NUMERIC, useRefOptions, type FieldMeta } from "@/lib/config";

/** One input for a configured field, chosen by its Veko type. */
export function FieldInput({
  field,
  value,
  onChange,
  id,
  label,
  invalid,
  disabled,
}: {
  field: FieldMeta;
  value: unknown;
  onChange: (v: unknown) => void;
  id?: string;
  label: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const t = field.type;
  const common = { id, "aria-label": id ? undefined : label, "aria-invalid": invalid || undefined, disabled };
  if (t === "Boolean") {
    return <input type="checkbox" {...common} aria-label={label} checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-4" />;
  }
  if (t === "Date") return <Input {...common} type="date" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
  if (NUMERIC.has(t)) {
    return <Input {...common} inputMode="decimal" className="text-right" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={t === "Money" ? "0.00" : "0"} />;
  }
  if (t === "Text") return <Input {...common} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
  return <RefSelect {...common} type={t} value={(value as string) ?? ""} onChange={onChange} />;
}

function RefSelect({ type, value, onChange, ...rest }: { type: string; value: string; onChange: (v: unknown) => void; id?: string; "aria-label"?: string; "aria-invalid"?: boolean; disabled?: boolean }) {
  const options = useRefOptions(type);
  return (
    <Select {...rest} value={value} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{options.isLoading ? "Loading…" : `Choose ${type}…`}</option>
      {options.data?.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
      {value && options.data && !options.data.some((o) => o.id === value) && <option value={value}>{value.slice(0, 8)}…</option>}
    </Select>
  );
}
