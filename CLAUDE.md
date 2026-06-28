# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hostable Maven repository (like Maven Central) implemented as a single **Cloudflare Worker**
in TypeScript. Artifacts live in **R2**, accounts/namespaces/the artifact index live in **D1**.
Public read, authenticated write via rotatable deploy keys, namespace ownership for multi-tenant
safety, signature-enforced + immutable releases, and snapshot repositories that garbage-collect.

The repo is also a **GitHub template**: `scripts/cli.mjs setup` bootstraps a user's Cloudflare
resources and `scripts/cli.mjs update` pulls later template changes into a derived repo while
preserving `wrangler.jsonc` (the only `PROTECTED_PATHS` entry).

## Commands

```sh
npm run dev            # wrangler dev — local Worker with local R2 + D1 (Miniflare)
npm test               # vitest run (unit + e2e) inside the Workers runtime
npm run test:watch     # vitest watch mode
npm run test:coverage  # coverage with thresholds (90% stmts/lines/funcs, 80% branches)
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint --deny-warnings   (NOT eslint)
npm run fmt            # oxfmt                     (NOT prettier; fmt:check for CI)
npm run check          # oxfmt --check && oxlint && tsc --noEmit && vitest run  ← what CI runs
npm run deploy         # wrangler deploy (CI does this on main after applying migrations)
```

Run a single test file or test by name:

```sh
npx vitest run test/unit/coordinates.test.ts
npx vitest run -t "maps -SNAPSHOT to the concrete build"
```

Admin CLI (all subcommands dispatch through `scripts/cli.mjs`; runs against the remote D1 by
default, `--local` for the dev DB, DB name from `$MAVEN_DB`, default `maven`):

```sh
npm run admin -- create-account <name> --pgp-key ./pub.asc
npm run admin -- add-namespace <name> <groupId-prefix>
npm run admin -- add-key <name> --label ci          # prints the key once
npm run admin -- revoke-key <name> <label>
npm run admin -- set-pgp-key <name> ./pub.asc
npm run admin -- list-accounts | list-keys <name> | list-namespaces <name>
```

## Architecture

### Request flow

`src/index.ts` is the only entry point. `fetch()`:

1. `resolveRepo()` (`config.ts`) matches `(hostname, path-prefix)` against the `REPOSITORIES`
   route table → `{ repo: "release"|"snapshot", r2Prefix, relPath }`. Exact host beats `"*"`;
   among equal hosts the longest path prefix wins. No match → 404.
2. `classifyPath()` (`coordinates.ts`) turns `relPath` into a typed **`Resource`** — this is the
   central abstraction the whole codebase keys off. Kinds: `artifact`, `signature` (`.asc`),
   `group-metadata`, `snapshot-metadata`, `checksum` (which wraps a target resource).
3. Dispatch by method + `resource.kind`: GET/HEAD → `read.ts` (artifacts), `metadata.ts`
   (generated XML), `checksums.ts` (generated digests), or `browse.ts` (HTML index for directory
   paths); PUT → `deploy.ts`.

`scheduled()` runs `runSnapshotGc()` (`gc.ts`) on the cron in `wrangler.jsonc`.

### Storage model — D1 is the source of record

- **One R2 bucket**, key = `r2Prefix + "/" + relPath` (`releases/...` vs `snapshots/...`). Both
  repos share the bucket; the prefix is the only separation.
- The D1 **`artifacts`** table (`migrations/0001_init.sql`) indexes **only primary artifacts**
  (jar/pom/classified files) — one row each, carrying `verified` and `deployed_at`. It drives all
  three derived behaviours from one place: metadata generation, signature gating, and GC.
- **Checksums, `.asc` signatures, and `maven-metadata.xml` are NOT indexed.** Metadata and all
  four checksums (`md5/sha1/sha256/sha512`) are **generated on demand** from the D1 index, never
  stored. Client uploads of metadata/checksums are accepted (`200`) and **discarded**
  (`isGenerated()` in `deploy.ts`), so generated output is always internally consistent.

### Release vs snapshot policy

The `release`/`snapshot` distinction is the spine of the system; the behavioural differences are
concentrated in `deploy.ts`, `read.ts`, `gc.ts`, and `http.ts`:

- **Suffix must match the repo** — `repoMatchesResource()` rejects a non-`-SNAPSHOT` version in a
  snapshot repo and vice-versa (group-level metadata, which has no version, fits either).
- **Releases**: immutable (re-PUT to an existing key → `409`), and **signature-gated**. A primary
  artifact is stored with `verified=0` and is invisible to reads (`isReleaseArtifactHidden()` →
  `404`) until its `.asc` PUT verifies against the account's PGP key (`signatures.ts`, openpgp.js);
  valid → `markVerified()`, invalid → the artifact is **deleted** so it can never be served. An
  account with no PGP key cannot deploy releases (`403`).
- **Snapshots**: mutable, indexed `verified=1` immediately, signatures stored but not gating, and
  pruned by GC — older than 90 days, **always keeping the newest build per `-SNAPSHOT` version**.
  `coordinates.ts`/`parseFilename()` handles unique timestamped builds (`base-yyyyMMdd.HHmmss-N`)
  as well as non-unique `-SNAPSHOT` names; snapshot version-level metadata maps the logical
  `-SNAPSHOT` to the concrete newest build.
- **Caching** (`cacheControlFor()` in `http.ts`): releases `immutable`/1yr, snapshots 60s,
  metadata 60s `must-revalidate`.

### Auth & namespace ownership

HTTP Basic, username = account name, password = a deploy key. Only the **SHA-256 hash** of a key
is stored (`auth.ts`); accounts hold multiple labelled keys (with optional expiry/revocation) for
zero-downtime rotation. A deploy is authorized only if the target groupId falls under a namespace
prefix the account owns (`accountOwnsGroup()`: exact or dotted-prefix match). Reads are unauthenticated.

## Conventions

- TypeScript ESM, Node 22+. Tooling is **oxlint + oxfmt**, not eslint/prettier — don't add the latter.
- `src/types.ts` holds shared types (`Env`, `RepoKind`, `RepositoryConfig`) and is excluded from
  coverage; everything else under `src/**` must clear the coverage thresholds.
- Tests run inside the real Workers runtime via `@cloudflare/vitest-pool-workers` (see
  `vitest.config.ts`); `test/apply-migrations.ts` applies the D1 migrations before each suite.
  e2e tests drive the Worker through `SELF.fetch(...)` against `https://repo.example.com` (the
  route table matches host `*`, so the hostname is arbitrary); unit tests exercise pure modules
  directly. `test/helpers.ts` has account/key/PGP setup helpers.
- The `REPOSITORIES` route table (in `wrangler.jsonc` `vars`) is pure configuration — public URLs
  are never hard-coded. Default is one host with `/releases` + `/snapshots`; a custom domain pins a
  real host and adds a matching Workers `route`.
