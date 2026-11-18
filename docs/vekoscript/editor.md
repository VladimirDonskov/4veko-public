# Editor integration

Open **Studio** in the Admin navigation. An owner or administrator can create an application,
enter VekoScript and choose **Check and review**. The Java service asks the Rust worker for
diagnostics and a migration plan against the active revision. The editor marks errors and
lets the author inspect each storage change. Publishing a risky plan requires a separate
approval. A successful publication records the source and revision in PostgreSQL. Studio
reloads those values when the author reopens the application.

Studio sends the base revision to both preview and publish. A changed source requires another
review. If another author publishes first, the editor retains the draft, provides a link to
inspect the active version, and offers an explicit reload. Other members can inspect
published catalog, document, register and handler metadata. Source and publication require
the platform administrator role. The existing `/configurator` serves TypeScript configurations.
[Studio integration test](../../apps/web/e2e-platform/studio.spec.ts)

## Run Studio locally

1. Start the ERP PostgreSQL database, apply its migrations and start the API and web app as
   described in the root README. Give Fastify and Spring the same development-only
   `VKS_JWT_SECRET` of at least 32 bytes. Fastify reads `VKS_PLATFORM_URL`, which defaults
   to `http://localhost:8090`.
2. Build the worker with `cargo build --release -p vks-cli` in `engine/vekoscript`.
   Create a separate platform database and set Spring's `VKS_DB_URL`, `VKS_DB_USER` and
   `VKS_DB_PASSWORD` for it. Start Spring in `backend` with `./mvnw spring-boot:run`
   (Windows uses `mvnw.cmd`). Flyway applies the platform migrations.
3. Sign in and open `/studio`. To run the browser scenario against **disposable** ERP and
   platform databases, set `E2E_BASE_URL` to the web origin and run
   `npm run test:studio -w @4veko/web`. The test creates a new organization, two members
   and two application revisions, and leaves them in the test databases.

## Browser assets

The web build bundles Monaco's ESM editor and worker under `/monaco/`. It resolves Monaco's
vendored sanitizer import to the project's pinned DOMPurify package and checks which source
actually supplied the emitted browser code. Keep the root and web Monaco versions aligned.
The root dependency makes npm apply the sanitizer override to Monaco in workspace installs.
The Chromium regression exercises VekoScript highlighting, positioned diagnostics, metadata
completion, the save shortcut and a worker-computed diff with external requests blocked.
[Browser regression](../../apps/web/e2e/monaco.spec.ts) · [Monaco ESM integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)

## Diagnostics contract

Three producers return the same shape:

- `vks check file.vks --json` (add `--script` to allow top-level statements),
- the worker's `checkResult` message,
- the platform's `POST /api/v1/apps/{app}/check` and failed deployments (`diagnostics`).

```json
{
  "code": "VKS3012",
  "kind": "semantic",
  "severity": "error",
  "message": "GoodsReceipt has no field \"totl\".",
  "line": 12, "col": 9,
  "offset": 341, "len": 13
}
```

`line` and `col` are 1-based; `col` counts Unicode scalar values. `offset` and `len` are UTF-8
byte positions in the source. Codes are stable; messages may improve.

## Mapping to Monaco

Monaco markers use 1-based lines and UTF-16 columns. For ASCII lines (VekoScript identifiers
are ASCII) `col` maps directly; for lines with non-ASCII string content, convert with the
line's text:

```ts
const marker = {
  severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
  message: `${d.message} (${d.code})`,
  startLineNumber: d.line,
  startColumn: utf16Column(lineText, d.col),
  endLineNumber: d.line,
  endColumn: utf16Column(lineText, d.col) + utf16Length(source, d.offset, d.len),
};
```

## Planned

- `vks lsp`: a language server over stdio (diagnostics on change, hover with metadata types,
  completion of fields, methods and events from the analyzer's type knowledge, go to
  definition for functions and objects).
- A staged migration path for existing TypeScript configurations and their records.
