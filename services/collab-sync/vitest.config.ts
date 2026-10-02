import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Worker tests open sockets and move megabytes; next to other
    // processes they need more than the 5 s default. A timeout only has to
    // catch a hang.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only shim secret (PROTOCOL.md): never present in deployed vars.
        // PERSONAL_SPACE_SALT (PERSONAL-SYNC.md §2.1) is test-only here too —
        // the real value is a deployed secret, never checked in.
        bindings: {
          TEST_AUTH_SECRET: "test-secret-for-vitest-only",
          PERSONAL_SPACE_SALT: "test-personal-space-salt-for-vitest-only",
          // PERSONAL-SYNC.md §3.7: device access-token key, test-only here.
          DEVICE_TOKEN_SECRET: "test-device-token-secret-for-vitest-only",
        },
        // The `ASSETS` R2 binding is deliberately NOT declared in
        // wrangler.jsonc yet (R2 isn't enabled on the deploy account — see
        // that file's comment), so it is injected only here: Miniflare
        // simulates R2 entirely locally, with no real Cloudflare API access,
        // which is exactly what lets the asset-route tests run today. One
        // test (test/assets.spec.ts) also exercises the `env.ASSETS`-absent
        // 503 path directly, since every test in this file otherwise has the
        // binding present.
        r2Buckets: { ASSETS: "test-personal-assets" },
      },
    }),
  ],
});
