// Build the browser editor and its worker from ESM. Monaco 0.57 vendors a separate copy
// of DOMPurify even in ESM, so route that import to our locked upstream release.
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, "../public/monaco");
const sanitizer = fileURLToPath(import.meta.resolve("dompurify"));
const monacoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.resolve("monaco-editor")))));
const result = await build({
  entryPoints: {
    editor: join(here, "monaco-browser.mjs"),
    "editor-worker": fileURLToPath(import.meta.resolve("monaco-editor/editor/editor.worker.js")),
  },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: true,
  metafile: true,
  legalComments: "linked",
  loader: { ".ttf": "file" },
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  plugins: [{
    name: "upstream-dompurify",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/dompurify\/dompurify\.js$/ }, () => ({ path: sanitizer }));
    },
  }],
});

const editorInputs = Object.entries(result.metafile.outputs)
  .filter(([path]) => path.endsWith(".js"))
  .flatMap(([, output]) => Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
if (!editorInputs.some(path => resolve(path) === sanitizer) || editorInputs.some(path => path.endsWith("/browser/dompurify/dompurify.js"))) {
  throw new Error("Monaco's browser bundle must use the project's DOMPurify dependency.");
}
await mkdir(outdir, { recursive: true });
for (const file of ["LICENSE", "ThirdPartyNotices.txt"]) await cp(join(monacoRoot, file), join(outdir, file));
const outputs = new Set(Object.keys(result.metafile.outputs).map(path => resolve(path)));
for (const dir of ["chunks", "assets"]) {
  for (const file of await readdir(join(outdir, dir), { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(outdir, dir, file.name);
    // esbuild's linked license notices accompany a JS/CSS output.
    if (!outputs.has(path.replace(/\.LEGAL\.txt$/, ""))) await rm(path);
  }
}
// Remove the generated AMD assets left by the previous version of this build script.
await rm(join(outdir, "vs"), { recursive: true, force: true });
