import { applyD1Migrations, env } from "cloudflare:test";

// Apply D1 migrations once per test worker, before any test runs.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
