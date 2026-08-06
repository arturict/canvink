import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("landing publishes crawlable product and agent metadata", async () => {
  const [html, robots, sitemap, llms] = await Promise.all([
    read("index.html"),
    read("public/robots.txt"),
    read("public/sitemap.xml"),
    read("public/llms.txt"),
  ]);

  assert.match(html, /<title>Canvink — Local-first ink and PDF notebook<\/title>/u);
  assert.match(html, /rel="canonical" href="https:\/\/canvink\.vercel\.app\/"/u);
  assert.match(html, /"@type": \["SoftwareApplication", "SoftwareSourceCode"\]/u);
  assert.match(robots, /^User-agent: OAI-SearchBot$/mu);
  assert.match(sitemap, /<loc>https:\/\/canvink\.vercel\.app\/<\/loc>/u);
  assert.doesNotMatch(sitemap, /<loc>https:\/\/canvink\.vercel\.app\/app<\/loc>/u);
  assert.doesNotMatch(html, /checklists|offline web app|softwareVersion/u);
  assert.match(llms, /local-first mixed-media notebook/u);
  assert.match(llms, /Current status: public alpha/u);
});
