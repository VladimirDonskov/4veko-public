import * as monaco from "monaco-editor";

globalThis.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL("./editor-worker.js", import.meta.url), { type: "module" });
  },
};
globalThis.monaco = monaco;
