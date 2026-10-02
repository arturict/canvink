// D5: CLERK_ISSUER must be mandatory for real-JWT verification (fail-closed).
// These tests mint real RS256 JWTs (not the TEST_AUTH_SECRET shim) against a
// throwaway keypair, and stub `fetch` so `verifyClerkJwt`'s JWKS lookup
// resolves to that keypair's public key without any network access.
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBearerToken } from "../src/auth/clerk";
import { bytesToBase64Url } from "../src/util/crypto";

function b64Json(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

async function signJwt(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const headerB64 = b64Json({ alg: "RS256", kid });
  const payloadB64 = b64Json(claims);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signingInput);
  return `${headerB64}.${payloadB64}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function stubJwks(publicKey: CryptoKey, kid: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const jwk = await crypto.subtle.exportKey("jwk", publicKey);
      return Response.json({ keys: [{ ...jwk, kid }] });
    }),
  );
}

describe("D5: Clerk verification fails closed without CLERK_ISSUER", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a real, correctly-signed RS256 JWT when CLERK_ISSUER is unset, even with a JWKS URL configured", async () => {
    const { publicKey, privateKey } = await makeRsaKeyPair();
    stubJwks(publicKey, "kid-1");
    const jwt = await signJwt(privateKey, "kid-1", {
      iss: "https://example.clerk.accounts.dev",
      sub: "user_1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(
      verifyBearerToken(jwt, { CLERK_JWKS_URL: "https://example.com/.well-known/jwks.json" }),
    ).rejects.toThrow();
  });

  it("accepts the same JWT once CLERK_ISSUER matches", async () => {
    const { publicKey, privateKey } = await makeRsaKeyPair();
    stubJwks(publicKey, "kid-2");
    const jwt = await signJwt(privateKey, "kid-2", {
      iss: "https://example.clerk.accounts.dev",
      sub: "user_2",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const identity = await verifyBearerToken(jwt, {
      CLERK_ISSUER: "https://example.clerk.accounts.dev",
      CLERK_JWKS_URL: "https://example.com/.well-known/jwks.json",
    });
    expect(identity.sub).toBe("user_2");
  });

  it("rejects when the JWT's iss does not match a configured CLERK_ISSUER", async () => {
    const { publicKey, privateKey } = await makeRsaKeyPair();
    stubJwks(publicKey, "kid-3");
    const jwt = await signJwt(privateKey, "kid-3", {
      iss: "https://attacker.clerk.accounts.dev",
      sub: "user_3",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(
      verifyBearerToken(jwt, {
        CLERK_ISSUER: "https://example.clerk.accounts.dev",
        CLERK_JWKS_URL: "https://example.com/.well-known/jwks.json",
      }),
    ).rejects.toThrow();
  });

  it("D5: rejects a JWT whose azp is not in CLERK_AUTHORIZED_PARTIES", async () => {
    const { publicKey, privateKey } = await makeRsaKeyPair();
    stubJwks(publicKey, "kid-4");
    const jwt = await signJwt(privateKey, "kid-4", {
      iss: "https://example.clerk.accounts.dev",
      sub: "user_4",
      azp: "https://not-allowed.example",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(
      verifyBearerToken(jwt, {
        CLERK_ISSUER: "https://example.clerk.accounts.dev",
        CLERK_JWKS_URL: "https://example.com/.well-known/jwks.json",
        CLERK_AUTHORIZED_PARTIES: "https://allowed.example,https://also-allowed.example",
      }),
    ).rejects.toThrow();
  });

  it("D5: accepts a JWT whose azp is in CLERK_AUTHORIZED_PARTIES", async () => {
    const { publicKey, privateKey } = await makeRsaKeyPair();
    stubJwks(publicKey, "kid-5");
    const jwt = await signJwt(privateKey, "kid-5", {
      iss: "https://example.clerk.accounts.dev",
      sub: "user_5",
      azp: "https://allowed.example",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const identity = await verifyBearerToken(jwt, {
      CLERK_ISSUER: "https://example.clerk.accounts.dev",
      CLERK_JWKS_URL: "https://example.com/.well-known/jwks.json",
      CLERK_AUTHORIZED_PARTIES: "https://allowed.example",
    });
    expect(identity.sub).toBe("user_5");
  });

  it("punch-list: rejects a real RS256 JWT with no exp claim at all (it must not live forever)", async () => {
    const { publicKey, privateKey } = await makeRsaKeyPair();
    stubJwks(publicKey, "kid-6");
    const jwt = await signJwt(privateKey, "kid-6", {
      iss: "https://example.clerk.accounts.dev",
      sub: "user_no_exp",
      // deliberately no `exp` field at all
    });

    await expect(
      verifyBearerToken(jwt, {
        CLERK_ISSUER: "https://example.clerk.accounts.dev",
        CLERK_JWKS_URL: "https://example.com/.well-known/jwks.json",
      }),
    ).rejects.toThrow(/exp/i);
  });

  it("the TEST_AUTH_SECRET shim is unaffected by CLERK_ISSUER being unset", async () => {
    const identity = await verifyBearerToken("test:user_6:not-checked-because-mac-is-verified-below", {
      TEST_AUTH_SECRET: "shim-secret",
    }).catch((error: Error) => error);
    // Wrong MAC still throws, but crucially it throws for a MAC reason, not
    // because of the (absent) CLERK_ISSUER — proving the shim path never
    // reaches `verifyClerkJwt` at all.
    expect(identity).toBeInstanceOf(Error);
    expect((identity as Error).message).toMatch(/mac/i);
  });
});
