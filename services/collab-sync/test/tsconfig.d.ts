// Ambient env typing consumed by `cloudflare:test`'s `Cloudflare.Env` global
// (mirrors what `wrangler types` would generate for this worker).
import type { Env as WorkerEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_AUTH_SECRET: string;
      PERSONAL_SPACE_SALT: string;
      DEVICE_TOKEN_SECRET: string;
    }
  }
}

export {};
