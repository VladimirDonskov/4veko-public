"use client";

import Editor, { loader, type OnMount } from "@monaco-editor/react";
import Script from "next/script";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Diagnostic, Model } from "@/lib/platform";

type Monaco = typeof import("monaco-editor");
declare global {
  interface Window {
    monaco?: Monaco;
  }
}

const RESERVED = ["let", "function", "return", "if", "else", "while", "for", "in", "break", "continue", "on", "true", "false", "null"];
const CONTEXTUAL = ["catalog", "document", "register", "information", "periodic", "field", "rows", "dimension", "measure", "resource", "required", "unique", "default"];
const TYPES = ["String", "Decimal", "Integer", "Boolean", "Date", "DateTime", "Ref"];
const ROOTS = ["Catalog", "Document", "Register", "Context"];
const EVENTS = ["BeforeCreate", "AfterCreate", "BeforeSave", "AfterSave", "BeforePost", "Post", "AfterPost", "BeforeReverse", "AfterReverse", "BeforeDelete", "AfterDelete"];
const BUILTINS = ["str", "int", "decimal", "bool", "round", "abs", "min", "max", "date", "dateTime", "now", "today", "days", "hours", "minutes", "seconds", "money", "format", "typeOf", "reject", "notify", "log", "range"];

/** Retain the last successful check for this editor's document while the user edits it. */
const completionModels = new WeakMap<import("monaco-editor").editor.ITextModel, Model>();
let registered = false;

function register(monaco: Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: "vekoscript", extensions: [".vks"] });
  monaco.languages.setMonarchTokensProvider("vekoscript", {
    reserved: RESERVED,
    contextual: CONTEXTUAL,
    types: TYPES,
    roots: ROOTS,
    events: EVENTS,
    builtins: BUILTINS,
    tokenizer: {
      root: [
        [/[a-zA-Z_]\w*/, { cases: { "@reserved": "keyword", "@contextual": "keyword.declaration", "@types": "type", "@roots": "type.root", "@events": "type.event", "@builtins": "predefined", "@default": "identifier" } }],
        { include: "@whitespace" },
        [/[{}()[\]]/, "@brackets"],
        [/\d+\.\d+/, "number.float"],
        [/\d+/, "number"],
        [/"/, "string", "@string"],
        [/[;,.:]/, "delimiter"],
        [/[=><!+\-*/%&|]+/, "operator"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\(u\{[0-9A-Fa-f]+\}|["\\ntr])/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, "white"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  } as Parameters<Monaco["languages"]["setMonarchTokensProvider"]>[1]);
  monaco.languages.setLanguageConfiguration("vekoscript", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [{ open: "{", close: "}" }, { open: "(", close: ")" }, { open: '"', close: '"' }],
    indentationRules: { increaseIndentPattern: /\{[^}]*$/, decreaseIndentPattern: /^\s*\}/ },
  });

  const K = monaco.languages.CompletionItemKind;
  const Snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  monaco.languages.registerCompletionItemProvider("vekoscript", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const items = [
        ...[...RESERVED, ...CONTEXTUAL].map((k) => ({ label: k, kind: K.Keyword, insertText: k, range })),
        ...TYPES.map((t) => ({ label: t, kind: K.TypeParameter, insertText: t, range })),
        ...ROOTS.map((t) => ({ label: t, kind: K.Module, insertText: t, range })),
        ...EVENTS.map((e) => ({ label: e, kind: K.Event, insertText: e, range })),
        ...BUILTINS.map((b) => ({ label: b, kind: K.Function, insertText: `${b}($0)`, insertTextRules: Snippet, range })),
        { label: "on … handler", kind: K.Snippet, insertText: "on ${1:Type}.${2:BeforeSave}(${3:document}) {\n\t$0\n}", insertTextRules: Snippet, range },
        { label: "catalog …", kind: K.Snippet, insertText: "catalog ${1:Name} {\n\tfield ${2:code}: String(${3:20}) required unique;\n\tfield name: String(200) required;\n}", insertTextRules: Snippet, range },
        { label: "document …", kind: K.Snippet, insertText: "document ${1:Name} {\n\tfield ${2:field}: ${3:String(50)};\n\n\trows ${4:items} {\n\t\tfield ${5:quantity}: Decimal(18, 3) required;\n\t}\n}", insertTextRules: Snippet, range },
        { label: "register …", kind: K.Snippet, insertText: "register ${1:Name} {\n\tdimension ${2:item}: Ref<${3:Type}>;\n\tmeasure ${4:quantity}: Decimal(18, 3);\n}", insertTextRules: Snippet, range },
        { label: "function …", kind: K.Snippet, insertText: "function ${1:name}(${2}) {\n\t$0\n}", insertTextRules: Snippet, range },
      ];
      const m = completionModels.get(model);
      if (m) {
        const objects = [...m.catalogs, ...m.documents];
        for (const o of objects) {
          items.push({ label: o.name, kind: K.Class, insertText: o.name, range });
          for (const f of o.fields) items.push({ label: f.name, kind: K.Field, insertText: f.name, range });
        }
        for (const d of m.documents) for (const r of d.rows) {
          items.push({ label: r.name, kind: K.Property, insertText: r.name, range });
          for (const f of r.fields) items.push({ label: f.name, kind: K.Field, insertText: f.name, range });
        }
        for (const r of m.registers) {
          items.push({ label: r.name, kind: K.Class, insertText: r.name, range });
          for (const f of [...r.dimensions, ...r.values]) items.push({ label: f.name, kind: K.Field, insertText: f.name, range });
        }
      }
      const seen = new Set<string>();
      return { suggestions: items.filter((i) => (seen.has(`${i.kind}:${i.label}`) ? false : (seen.add(`${i.kind}:${i.label}`), true))) };
    },
  });

  const common = { inherit: true, encodedTokensColors: [] as string[] };
  monaco.editor.defineTheme("veko-light", {
    ...common,
    base: "vs",
    rules: [
      { token: "keyword", foreground: "0b6e5f", fontStyle: "bold" },
      { token: "keyword.declaration", foreground: "0b6e5f" },
      { token: "type", foreground: "1f5fad" },
      { token: "type.root", foreground: "1f5fad", fontStyle: "bold" },
      { token: "type.event", foreground: "7a3fb0" },
      { token: "predefined", foreground: "8a5300" },
      { token: "string", foreground: "1d6f42" },
      { token: "number", foreground: "b42318" },
      { token: "comment", foreground: "59615b", fontStyle: "italic" },
    ],
    colors: { "editor.background": "#ffffff", "editorLineNumber.foreground": "#848b84" },
  });
  monaco.editor.defineTheme("veko-dark", {
    ...common,
    base: "vs-dark",
    rules: [
      { token: "keyword", foreground: "3dbfa5", fontStyle: "bold" },
      { token: "keyword.declaration", foreground: "3dbfa5" },
      { token: "type", foreground: "7fb0f0" },
      { token: "type.root", foreground: "7fb0f0", fontStyle: "bold" },
      { token: "type.event", foreground: "c7a2f0" },
      { token: "predefined", foreground: "f2b544" },
      { token: "string", foreground: "5cc98a" },
      { token: "number", foreground: "f97a6c" },
      { token: "comment", foreground: "a3aca6", fontStyle: "italic" },
    ],
    colors: { "editor.background": "#0f1211", "editorLineNumber.foreground": "#737c76" },
  });
}

/** Character index of a UTF-8 byte offset (the engine reports byte offsets; Monaco counts UTF-16). */
export function utf16Index(text: string, byteOffset: number) {
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byteOffset) {
    const cp = text.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

function isDark() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export type VksEditorHandle = { goTo: (line: number, col: number) => void };

export const VksEditor = forwardRef<
  VksEditorHandle,
  { value: string; onChange: (v: string) => void; diagnostics: Diagnostic[]; model: Model | null; onSave?: () => void; readOnly?: boolean; label: string }
>(function VksEditor({ value, onChange, diagnostics, model, onSave, readOnly, label }, ref) {
  const [assetState, setAssetState] = useState<"loading" | "ready" | "error">("loading");
  const [mounted, setMounted] = useState(false);
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const save = useRef(onSave);
  save.current = onSave;

  useImperativeHandle(ref, () => ({
    goTo(line, col) {
      const e = editor.current;
      if (!e) return;
      e.revealLineInCenter(line);
      e.setPosition({ lineNumber: line, column: col });
      e.focus();
    },
  }));

  useEffect(() => {
    const document = editor.current?.getModel();
    if (model && document) completionModels.set(document, model);
  }, [model, mounted]);

  // Diagnostics become squiggles and gutter marks.
  useEffect(() => {
    const monaco = monacoRef.current;
    const m = editor.current?.getModel();
    if (!monaco || !m) return;
    const text = m.getValue();
    monaco.editor.setModelMarkers(
      m,
      "vks",
      diagnostics.map((d) => {
        const start = m.getPositionAt(utf16Index(text, d.offset));
        const end = m.getPositionAt(utf16Index(text, d.offset + Math.max(d.len, 1)));
        return {
          severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: `${d.message} (${d.code})`,
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column === start.column && end.lineNumber === start.lineNumber ? start.column + 1 : end.column,
        };
      }),
    );
  }, [diagnostics, value, mounted]);

  // Follow the app's light/dark choice.
  useEffect(() => {
    const observer = new MutationObserver(() => monacoRef.current?.editor.setTheme(isDark() ? "veko-dark" : "veko-light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <link rel="stylesheet" href="/monaco/editor.css" precedence="default" />
      <Script
        type="module"
        src="/monaco/editor.js"
        onReady={() => {
          const monaco = window.monaco;
          if (!monaco?.editor) {
            setAssetState("error");
            return;
          }
          loader.config({ monaco });
          setAssetState("ready");
        }}
        onError={() => setAssetState("error")}
      />
      {assetState === "error" && <div role="alert" className="p-4 text-sm">The editor could not load. Reload this page to retry.</div>}
      {assetState === "loading" && <div className="p-4 text-sm text-muted">Loading the editor…</div>}
      {assetState === "ready" && (
        <Editor
          height="100%"
          language="vekoscript"
          value={value}
          theme={isDark() ? "veko-dark" : "veko-light"}
          beforeMount={register}
          onMount={(e, monaco) => {
            editor.current = e;
            monacoRef.current = monaco;
            setMounted(true);
            e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current?.());
            monaco.editor.setTheme(isDark() ? "veko-dark" : "veko-light");
          }}
          onChange={(v) => onChange(v ?? "")}
          loading={<div className="p-4 text-sm text-muted">Loading the editor…</div>}
          options={{
            ariaLabel: label,
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            tabSize: 4,
            insertSpaces: true,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            automaticLayout: true,
            fixedOverflowWidgets: true,
          }}
        />
      )}
    </>
  );
});
