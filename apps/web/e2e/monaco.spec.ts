import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Exercise the VekoScript editor independently of the optional Java service. The component
// and public assets are the same ones that Studio loads in a deployment.
test("VekoScript editor loads its sanitizer and worker locally and keeps language features", async ({ page, baseURL }) => {
  const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
  const fixture = await build({
    stdin: {
      resolveDir: sourceRoot,
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { VksEditor } from "./components/platform/vks-editor";
        const model = { catalogs: [{name: "Products", fields: []}], documents: [], registers: [] };
        const diagnostics = [{severity: "error", message: "Check the name", code: "TEST", offset: 4, len: 3}];
        function Fixture() {
          const [text, setText] = React.useState("let qty = 1;");
          return React.createElement(VksEditor, { value: text, onChange: setText, diagnostics, model,
            label: "Script editor", onSave: () => { document.title = "Saved"; } });
        }
        createRoot(document.getElementById("root")).render(React.createElement(Fixture));`,
    },
    bundle: true, write: false, jsx: "automatic", platform: "browser",
    define: { "process.env": '{"NODE_ENV":"production"}' },
  });
  const errors: string[] = [];
  const otherOrigins: string[] = [];
  const workerURLs: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("worker", worker => workerURLs.push(worker.url()));
  const origin = new URL(baseURL!).origin;
  await page.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== origin) {
      otherOrigins.push(route.request().url());
      return route.abort();
    }
    return route.fallback();
  });
  await page.route("**/__editor_fixture", route => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><div id="root" style="height:500px"></div><script src="/__editor_fixture.js"></script>' }));
  await page.route("**/__editor_fixture.js", route => route.fulfill({ contentType: "text/javascript", body: fixture.outputFiles[0].text }));
  await page.goto("/__editor_fixture");
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const { editor } = window.monaco!;
    const m = editor.getModels()[0];
    return { language: m.getLanguageId(), marker: editor.getModelMarkers({ resource: m.uri })[0]?.message,
      tokens: editor.tokenize("let qty = 1;", "vekoscript")[0].map(token => token.type) };
  })).toEqual({ language: "vekoscript", marker: "Check the name (TEST)", tokens: expect.arrayContaining(["keyword.vekoscript"]) });
  await page.evaluate(() => {
    const { editor } = window.monaco!;
    const instance = editor.getEditors()[0];
    instance.setPosition({ lineNumber: 1, column: instance.getModel()!.getLineMaxColumn(1) });
    instance.focus();
  });
  await expect.poll(() => page.evaluate(() => window.monaco!.editor.getEditors()[0].hasTextFocus())).toBe(true);
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Prod");
  await expect.poll(() => page.evaluate(() => window.monaco!.editor.getModels()[0].getLineContent(2))).toBe("Prod");
  await page.evaluate(() => window.monaco!.editor.getEditors()[0].getAction("editor.action.triggerSuggest")!.run());
  await expect(page.locator(".suggest-widget.visible")).toContainText("Products");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+s");
  await expect(page).toHaveTitle("Saved");

  // A computed line diff requires a responding editor worker.
  await page.evaluate(() => {
    const { editor } = window.monaco!;
    const target = document.body.appendChild(document.createElement("div"));
    target.style.cssText = "width:600px;height:180px";
    const diff = editor.createDiffEditor(target);
    diff.setModel({ original: editor.createModel("original"), modified: editor.createModel("updated") });
  });
  await expect.poll(() => page.evaluate(() => {
    const { editor } = window.monaco!;
    return editor.getDiffEditors()[0].getLineChanges()?.length;
  })).toBe(1);
  expect(workerURLs).toContain(origin + "/monaco/editor-worker.js");
  expect(otherOrigins).toEqual([]);
  expect(errors).toEqual([]);
});
