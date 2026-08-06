import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readBytes = (path) => readFile(new URL(`../${path}`, import.meta.url));

test("landing publishes crawlable product and agent metadata", async () => {
  const [html, robots, sitemap, llms, socialImage, socialImageSource] = await Promise.all([
    read("index.html"),
    read("public/robots.txt"),
    read("public/sitemap.xml"),
    read("public/llms.txt"),
    readBytes("public/canvink-social.png"),
    read("public/canvink-social.svg"),
  ]);

  assert.match(html, /<title>Canvink — Local-first ink and PDF notebook<\/title>/u);
  assert.match(html, /rel="canonical" href="https:\/\/canvink\.vercel\.app\/"/u);
  assert.match(html, /property="og:image" content="https:\/\/canvink\.vercel\.app\/canvink-social\.png"/u);
  assert.match(html, /name="twitter:image" content="https:\/\/canvink\.vercel\.app\/canvink-social\.png"/u);
  assert.match(html, /"@type": \["SoftwareApplication", "SoftwareSourceCode"\]/u);
  assert.match(robots, /^User-agent: OAI-SearchBot$/mu);
  assert.match(sitemap, /<loc>https:\/\/canvink\.vercel\.app\/<\/loc>/u);
  assert.doesNotMatch(sitemap, /<loc>https:\/\/canvink\.vercel\.app\/app<\/loc>/u);
  assert.doesNotMatch(sitemap, /<lastmod>/u);
  assert.doesNotMatch(html, /checklists|offline web app|softwareVersion/u);
  assert.match(llms, /local-first mixed-media notebook/u);
  assert.match(llms, /Current status: public alpha/u);
  assert.match(llms, /License: https:\/\/github\.com\/arturict\/canvink\/blob\/main\/LICENSE/u);
  assert.match(llms, /Changelog: https:\/\/github\.com\/arturict\/canvink\/blob\/main\/CHANGELOG\.md/u);
  assert.match(llms, /Known limitations: https:\/\/github\.com\/arturict\/canvink\/blob\/main\/docs\/architecture\.md#known-architectural-limitations/u);
  assert.ok(socialImage.length > 10_000);
  assert.match(socialImageSource, /viewBox="0 0 1200 630"/u);
});
