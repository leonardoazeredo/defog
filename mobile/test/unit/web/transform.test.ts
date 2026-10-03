import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { scriptHash } from "../../../scripts/web/csp.js";
import { BuildError, transformIndexHtml } from "../../../scripts/web/transform.js";

const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="vendor/a.css"></head>
<body><p id="x"></p>
<script data-goatcounter="https://szapalak.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
<script src="src/one.js"></script><script src="src/two.js"></script></body></html>`;

const files: Record<string, string> = {
  "vendor/a.css": "p{color:red}",
  "src/one.js": "var one = 1;",
  "src/two.js": 'var s = "</script>";',
};

const run = (html = page) => transformIndexHtml(html, (p) => files[p]!, "var adapter = 1;");

const parse = (html: string) => parseHTML(html).document;

it("removes GoatCounter", () => expect(run()).not.toContain("goatcounter"));

it("puts the CSP right after the charset, then the adapter", () => {
  const head = parse(run()).head.children;
  expect(head[0]!.getAttribute("charset")).toBe("utf-8");
  expect(head[1]!.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  expect(head[2]!.textContent).toBe("var adapter = 1;");
});

it("inlines local scripts in order, escaping </script", () => {
  const scripts = [...parse(run()).querySelectorAll("script")].map((s) => s.textContent);
  expect(scripts).toEqual(["var adapter = 1;", "var one = 1;", 'var s = "<\\/script>";']);
});

it("inlines local stylesheets", () =>
  expect(parse(run()).querySelector("style")!.textContent).toBe("p{color:red}"));

it("lists the hash of every inline script in the CSP", () => {
  const doc = parse(run());
  const csp = doc
    .querySelector('meta[http-equiv="Content-Security-Policy"]')!
    .getAttribute("content")!;
  for (const s of doc.querySelectorAll("script")) expect(csp).toContain(scriptHash(s.textContent!));
});

it("fails on an external script", () =>
  expect(() => run(page.replace("src/two.js", "https://cdn.example.com/x.js"))).toThrow(
    "External script not allowed: https://cdn.example.com/x.js",
  ));

it("fails on a protocol-relative script", () =>
  expect(() => run(page.replace("src/two.js", "//cdn.example.com/x.js"))).toThrow(
    "External script not allowed: //cdn.example.com/x.js",
  ));

it("fails on an external stylesheet", () =>
  expect(() => run(page.replace("vendor/a.css", "https://cdn.example.com/a.css"))).toThrow(
    "External stylesheet not allowed: https://cdn.example.com/a.css",
  ));

it("BuildError is exported", () => expect(new BuildError("x")).toBeInstanceOf(Error));
