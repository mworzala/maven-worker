/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as WorkerEnv } from "../src/types";

// The `env` exposed by `cloudflare:test` is typed as `Cloudflare.Env`. Make it carry our
// worker bindings plus the migrations binding the test harness injects.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
