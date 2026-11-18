"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/inputs";
import { cn } from "@/lib/cn";
import { COLLECTION, isRef, platform, type FieldMeta, type FieldType, type PlatformObject, type Ref, type Value } from "@/lib/platform";

/** What an input holds while the user edits: text for scalars, a boolean, or a reference. */
export type Draft = string | boolean | Ref | null;

/** The draft for a stored value (or a metadata default for new records). */
export function toDraft(type: FieldType, v: Value | undefined): Draft {
  if (v === null || v === undefined) return type.kind === "boolean" ? false : type.kind === "ref" ? null : "";
  if (type.kind === "boolean") return Boolean(v);
  if (type.kind === "ref") return isRef(v) ? v : null;
  if (type.kind === "dateTime") return String(v).slice(0, 16); // datetime-local, UTC
  return String(v);
}

export function defaultDraft(f: FieldMeta): Draft {
  const d = f.default;
  if (!d || d.type === "null") return toDraft(f.type, null);
  return toDraft(f.type, d.value as Value);
}

/** Why a draft cannot be sent, or null. Mirrors the platform's checks; the platform decides. */
export function draftProblem(f: FieldMeta, d: Draft): string | null {
  const empty = d === null || d === "";
  if (empty) return f.required ? "Required." : null;
  const t = f.type;
  if (typeof d !== "string") return null;
  const s = d.trim();
  if (t.kind === "string" && t.maxLength && [...d].length > t.maxLength) return `At most ${t.maxLength} characters.`;
  if (t.kind === "integer" && !/^-?\d+$/.test(s)) return "Enter a whole number.";
  if (t.kind === "decimal") {
    const m = /^-?(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[1] === "" && !m[2])) return "Enter a number, like 1250.00.";
    const scale = t.scale ?? 0;
    const intDigits = m[1]!.replace(/^0+/, "").length;
    if ((m[2] ?? "").replace(/0+$/, "").length > scale) return scale === 0 ? "Whole numbers only." : `At most ${scale} decimal places.`;
    if (intDigits > (t.precision ?? 28) - scale) return `At most ${(t.precision ?? 28) - scale} digits before the decimal point.`;
  }
  return null;
}

/** The JSON the platform API expects for a draft. */
export function fromDraft(type: FieldType, d: Draft): unknown {
  if (d === null || d === "") return null;
  switch (type.kind) {
    case "boolean":
      return Boolean(d);
    case "ref":
      return isRef(d) ? d.id : null;
    case "dateTime":
      return `${String(d)}:00Z`;
    case "string":
      return String(d);
    default:
      return String(d).trim();
  }
}

type ControlProps = { id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string; required?: boolean };

export function FieldInput({
  app,
  field,
  value,
  onChange,
  disabled,
  compact,
  control,
  label,
}: {
  app: string;
  field: FieldMeta;
  value: Draft;
  onChange: (v: Draft) => void;
  disabled?: boolean;
  compact?: boolean;
  control?: ControlProps;
  label?: string;
}) {
  const t = field.type;
  const common = { ...control, disabled, "aria-label": control?.id ? undefined : label, className: compact ? "h-8" : undefined };
  switch (t.kind) {
    case "boolean":
      return (
        <input
          type="checkbox"
          {...common}
          className="size-4 accent-[var(--accent)]"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "ref":
      return <RefPicker app={app} type={t.target!} kind={t.targetKind!} value={isRef(value) ? value : null} onChange={onChange} disabled={disabled} control={control} label={label} compact={compact} />;
    case "date":
      return <Input type="date" {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "dateTime":
      return <Input type="datetime-local" {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "decimal":
    case "integer":
      return (
        <Input
          {...common}
          inputMode={t.kind === "integer" || t.scale === 0 ? "numeric" : "decimal"}
          className={cn("tabular text-right", compact && "h-8")}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <Input {...common} maxLength={t.maxLength ?? undefined} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Searchable picker for a reference: an ARIA combobox over the target catalog or document
 * list, searched on the server.
 */
export function RefPicker({
  app,
  type,
  kind,
  value,
  onChange,
  disabled,
  control,
  label,
  compact,
}: {
  app: string;
  type: string;
  kind: "catalog" | "document";
  value: Ref | null;
  onChange: (v: Ref | null) => void;
  disabled?: boolean;
  control?: ControlProps;
  label?: string;
  compact?: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const search = useDebounced(text, 200);
  const q = useQuery({
    queryKey: ["platform", "picker", app, type, search],
    enabled: open,
    staleTime: 10_000,
    queryFn: () => platform<PlatformObject[]>(`/apps/${app}/${COLLECTION[kind]}/${type}?limit=20${search ? `&q=${encodeURIComponent(search)}` : ""}`),
  });
  const options = q.data ?? [];
  useEffect(() => setActive(0), [search]);

  function choose(o: PlatformObject) {
    onChange({ type, id: o.id, display: o.display });
    setOpen(false);
    setText("");
  }

  return (
    <div className="relative">
      <Input
        ref={input}
        {...control}
        aria-label={control?.id ? undefined : label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        disabled={disabled}
        placeholder={`Search ${type}…`}
        className={cn(compact && "h-8", value && "pr-8")}
        value={open ? text : (value?.display ?? (value ? value.id.slice(0, 8) : ""))}
        onFocus={() => {
          setOpen(true);
          setText("");
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setOpen(true);
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open && options[active]) {
            e.preventDefault();
            choose(options[active]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {value && !disabled && !open && (
        <button
          type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
          aria-label={`Clear ${label ?? type}`}
          onClick={() => {
            onChange(null);
            input.current?.focus();
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
      {open && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full min-w-56 overflow-auto rounded-md border border-border bg-bg py-1 shadow-pop">
          {q.isLoading && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {!q.isLoading && options.length === 0 && <li className="px-3 py-2 text-sm text-muted">No {type} found.</li>}
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn("cursor-pointer px-3 py-1.5 text-sm", i === active && "bg-accent-soft text-accent")}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
            >
              {o.display ?? o.id}
              {typeof o.fields.code === "string" && o.fields.code !== o.display && <span className="ml-2 text-xs text-muted">{o.fields.code}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
