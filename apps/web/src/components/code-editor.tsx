"use client";

import { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode } from "react";

const KEYWORDS = new Set(
  "catalog document register function field table dimension resource required nonnegative on end let if elif else for in while return fail break continue and or not true false null this".split(" "),
);
const TYPES = new Set(["Text", "Number", "Money", "Quantity", "Date", "Boolean", "Customer", "Vendor", "Item", "Account"]);

/** Token colors for Veko source, using theme tokens so both themes stay readable. */
function highlight(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"?)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(source))) {
    if (m.index > last) out.push(source.slice(last, m.index));
    const [text, comment, str, num, word] = m;
    if (comment) out.push(<span key={k++} className="text-muted italic">{text}</span>);
    else if (str) out.push(<span key={k++} className="text-success">{text}</span>);
    else if (num) out.push(<span key={k++} className="text-warning">{text}</span>);
    else if (word && KEYWORDS.has(word)) out.push(<span key={k++} className="font-semibold text-accent">{text}</span>);
    else if (word && (TYPES.has(word) || /^[A-Z]/.test(word))) out.push(<span key={k++} className="text-info">{text}</span>);
    else out.push(text);
    last = m.index + text.length;
  }
  out.push(source.slice(last));
  return out;
}

export type CodeEditorHandle = { goTo: (line: number, col: number) => void };

/**
 * A plain textarea over a highlighted copy of the same text: native editing,
 * undo and accessibility, with colors and a line-number gutter.
 */
export const CodeEditor = forwardRef<
  CodeEditorHandle,
  { value: string; onChange: (v: string) => void; readOnly?: boolean; errorLines?: Set<number>; onSave?: () => void; label: string }
>(function CodeEditor({ value, onChange, readOnly, errorLines, onSave, label }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const escaped = useRef(false);
  const lines = useMemo(() => value.split("\n").length, [value]);
  const highlighted = useMemo(() => highlight(value), [value]);

  useImperativeHandle(ref, () => ({
    goTo(line, col) {
      const el = area.current;
      if (!el) return;
      const rows = value.split("\n");
      let offset = 0;
      for (let i = 0; i < Math.min(line - 1, rows.length); i++) offset += rows[i]!.length + 1;
      offset += Math.max(0, col - 1);
      el.focus();
      el.setSelectionRange(offset, offset);
      const lineHeight = 20;
      el.scrollTop = Math.max(0, (line - 5) * lineHeight);
      syncScroll();
    },
  }));

  function syncScroll() {
    if (!area.current) return;
    if (pre.current) {
      pre.current.scrollTop = area.current.scrollTop;
      pre.current.scrollLeft = area.current.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = area.current.scrollTop;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    // Escape, then Tab, moves focus out instead of indenting (no keyboard trap, WCAG 2.1.2).
    if (e.key === "Escape") {
      escaped.current = true;
      return;
    }
    if (e.key === "Tab" && escaped.current) {
      escaped.current = false;
      return;
    }
    escaped.current = false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key === "Tab" && !readOnly && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Tab indents; Escape then Tab leaves the editor (keyboard users are never trapped).
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = el;
      const next = `${value.slice(0, s)}  ${value.slice(t)}`;
      onChange(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
    if (e.key === "Enter" && !readOnly) {
      // Keep the current line's indentation.
      e.preventDefault();
      const s = el.selectionStart;
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const indent = /^[ ]*/.exec(value.slice(lineStart, s))?.[0] ?? "";
      const next = `${value.slice(0, s)}\n${indent}${value.slice(el.selectionEnd)}`;
      onChange(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 1 + indent.length, s + 1 + indent.length));
    }
  }

  const shared = "m-0 whitespace-pre p-3 font-mono text-[13px] leading-5";
  return (
    <div className="flex h-[60vh] min-h-80 overflow-hidden rounded-md border border-border-input bg-bg focus-within:outline focus-within:outline-2 focus-within:outline-focus">
      <div ref={gutter} aria-hidden className="select-none overflow-hidden border-r border-border bg-surface py-3 text-right font-mono text-[13px] leading-5 text-muted">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={`px-2 ${errorLines?.has(i + 1) ? "bg-danger-soft font-semibold text-danger" : ""}`}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="relative flex-1">
        <pre ref={pre} aria-hidden className={`${shared} pointer-events-none absolute inset-0 overflow-hidden text-fg`}>
          {highlighted}
          {"\n"}
        </pre>
        <textarea
          ref={area}
          aria-label={label}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          className={`${shared} absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-[var(--text)] outline-none selection:bg-accent-soft`}
        />
      </div>
    </div>
  );
});
