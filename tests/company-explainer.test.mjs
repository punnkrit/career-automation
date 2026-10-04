import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = readFileSync(new URL("../src-ui/company-explainer.tsx", import.meta.url), "utf8");
let compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const name of ["react/jsx-runtime", "react"]) compiled = compiled.replaceAll(`from "${name}"`, `from "${import.meta.resolve(name)}"`);
const { CompanyExplainer, EVIDENCE_LABELS } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const data = { products: [], workflow: { steps: [] }, customer_examples: [], media: [] };
const render = (patch) => renderToStaticMarkup(createElement(CompanyExplainer, { data: { ...data, ...patch }, sources: [] }));
const media = { kind: "image", url: "https://cdn.example.com/product.png", source_url: "https://example.com/product", alt: "Product configuration interface", caption: "The interface used to configure a product.", as_of: "2026-09-21" };

test("sourced images render accessible captions, dates and privacy-preserving loading", () => {
  const html = render({ media: [media] });
  assert.match(html, /<figure/);
  assert.match(html, /<figcaption>The interface/);
  assert.match(html, /alt="Product configuration interface"/);
  assert.match(html, /Viewed 2026-09-21/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.match(html, /loading="lazy"/);
});

test("unusable or unsafe images are omitted; demos remain links, never autoplay embeds", () => {
  for (const url of ["javascript:alert(1)", "http://example.com/image.png", "https://127.0.0.1/image", "https://localhost/image", "https://user:password@example.com/image"]) {
    assert.doesNotMatch(render({ media: [{ ...media, url }] }), /<img/);
  }
  assert.doesNotMatch(render({ media: [{ ...media, alt: "" }] }), /<img/);
  const demo = render({ media: [{ ...media, kind: "demo" }] });
  assert.match(demo, /Explore the official demo/);
  assert.doesNotMatch(demo, /<(img|iframe|audio|video)/);
});

test("optional evidence stays optional and workflow labels distinguish company from third parties", () => {
  assert.doesNotMatch(render({}), /<figure|Customer examples/);
  const html = render({ workflow: { title: "A conversation", caption: "Example, not a customer deployment", source_urls: [], steps: [{ label: "Decide", detail: "Compose an answer", provider: "Third-party language model" }] } });
  assert.match(html, /Illustrative workflow/);
  assert.match(html, /Third-party language model/);
  assert.equal(EVIDENCE_LABELS.verified, "Source-supported");
  assert.equal(EVIDENCE_LABELS.company_reported, "Company-reported");
});
