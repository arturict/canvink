// PERSONAL-SYNC.md §3.5, §4.2, §9 Wave 1: R2 asset routes.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleAssetRoute } from "../src/assets";
import type { Env } from "../src/types";
import { assetRequest, createSpace, mintTestJwt, sha256HexOf } from "./helpers";

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

describe("asset routes: HEAD/PUT/GET/DELETE", () => {
  it("round-trips an asset and reports it absent after delete", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const bytes = randomBytes(1024);
    const hex = await sha256HexOf(bytes);

    const missingHead = await assetRequest(sub, "HEAD", `sha256:${hex}`);
    expect(missingHead.status).toBe(404);

    const put = await assetRequest(sub, "PUT", `sha256:${hex}`, {
      body: bytes,
      contentType: "image/png",
    });
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ assetId: `sha256:${hex}`, size: bytes.byteLength });

    const head = await assetRequest(sub, "HEAD", `sha256:${hex}`);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));

    const get = await assetRequest(sub, "GET", `sha256:${hex}`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    expect(get.headers.get("cache-control")).toContain("immutable");

    const del = await assetRequest(sub, "DELETE", `sha256:${hex}`);
    expect(del.status).toBe(204);

    const afterDelete = await assetRequest(sub, "HEAD", `sha256:${hex}`);
    expect(afterDelete.status).toBe(404);

    // DELETE is idempotent.
    const delAgain = await assetRequest(sub, "DELETE", `sha256:${hex}`);
    expect(delAgain.status).toBe(204);
  });

  it("accepts a bare 64-hex assetId form too", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const bytes = randomBytes(64);
    const hex = await sha256HexOf(bytes);

    const put = await assetRequest(sub, "PUT", hex, { body: bytes });
    expect(put.status).toBe(201);

    const head = await assetRequest(sub, "HEAD", hex);
    expect(head.status).toBe(200);
  });

  it("rejects a malformed assetId with 400", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    // GET, not HEAD: a HEAD response's body is stripped by the HTTP layer
    // regardless of what the handler wrote, so it can't assert on JSON here.
    const res = await assetRequest(sub, "GET", "not-a-valid-asset-id");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-asset-id" });
  });

  it("deduplicates a second PUT of the same hash", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const bytes = randomBytes(128);
    const hex = await sha256HexOf(bytes);

    const first = await assetRequest(sub, "PUT", `sha256:${hex}`, { body: bytes });
    expect(first.status).toBe(201);

    const second = await assetRequest(sub, "PUT", `sha256:${hex}`, { body: bytes });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      assetId: `sha256:${hex}`,
      size: bytes.byteLength,
      deduplicated: true,
    });
  });

  it("400 checksum-mismatch when the bytes don't match the claimed hash, and stores nothing", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const bytes = randomBytes(256);
    const wrongHex = await sha256HexOf(randomBytes(256)); // a different digest

    const put = await assetRequest(sub, "PUT", `sha256:${wrongHex}`, { body: bytes });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "checksum-mismatch" });

    const head = await assetRequest(sub, "HEAD", `sha256:${wrongHex}`);
    expect(head.status).toBe(404);
  });

  it("411 length-required when content-length is missing", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const jwt = await mintTestJwt(sub);
    // No body at all, so no content-length header is present to find.
    const request = new Request("https://example.com/api/v1/me/assets/sha256:" + "a".repeat(64), {
      method: "PUT",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const res = await handleAssetRoute(request, env as unknown as Env, "sha256:" + "a".repeat(64));
    expect(res.status).toBe(411);
  });

  it("413 asset-too-large when content-length exceeds 64 MiB", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const jwt = await mintTestJwt(sub);
    const hex = "b".repeat(64);
    const request = new Request(`https://example.com/api/v1/me/assets/sha256:${hex}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "content-length": String(64 * 1024 * 1024 + 1),
      },
      body: new Uint8Array(1),
    });
    const res = await handleAssetRoute(request, env as unknown as Env, `sha256:${hex}`);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "asset-too-large" });
  });

  it("rejects a missing/invalid bearer token with 401", async () => {
    const res = await SELF.fetch(`https://example.com/api/v1/me/assets/sha256:${"c".repeat(64)}`, {
      method: "HEAD",
    });
    expect(res.status).toBe(401);
  });

  it("isolation: a different sub cannot see the first sub's asset, even by exact hash", async () => {
    const subA = `user_a_${crypto.randomUUID()}`;
    const subB = `user_b_${crypto.randomUUID()}`;
    await createSpace(subA);
    await createSpace(subB);
    const bytes = randomBytes(96);
    const hex = await sha256HexOf(bytes);

    const put = await assetRequest(subA, "PUT", `sha256:${hex}`, { body: bytes });
    expect(put.status).toBe(201);

    const bHead = await assetRequest(subB, "HEAD", `sha256:${hex}`);
    expect(bHead.status).toBe(404);
    const bGet = await assetRequest(subB, "GET", `sha256:${hex}`);
    expect(bGet.status).toBe(404);
  });
});

describe("PERSONAL-SYNC.md: R2 not yet enabled on this account", () => {
  it("503s assets-not-configured when env.ASSETS is undefined, without touching the DO", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const jwt = await mintTestJwt(sub);
    const hex = "d".repeat(64);
    const request = new Request(`https://example.com/api/v1/me/assets/sha256:${hex}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const envWithoutAssets: Env = { ...(env as unknown as Env), ASSETS: undefined };
    const res = await handleAssetRoute(request, envWithoutAssets, `sha256:${hex}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "assets-not-configured" });
  });
});
