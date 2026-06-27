# maven-worker

A self-hostable Maven repository (like Maven Central) running on **Cloudflare Workers**, with
artifacts in **R2** and accounts/index in **D1**. Public read, authenticated write via rotatable
deploy keys, namespace ownership for multi-tenant safety, signature-enforced releases, immutable
releases, and snapshot repositories that garbage-collect after 90 days.

See [PLAN.md](./PLAN.md) for the full design.

## How it works

- **Read** (`GET`/`HEAD`) is public. Artifacts stream from R2; `maven-metadata.xml` and all four
  checksums (`.md5`/`.sha1`/`.sha256`/`.sha512`) are **generated** from the D1 index on demand.
- **Write** (`PUT`) needs HTTP Basic auth — username = account name, password = a deploy key.
- **Namespaces**: an account may only deploy under groupId prefixes it owns.
- **Releases** are immutable and **hidden until a valid PGP signature** (`.asc`) verifies them.
- **Snapshots** are mutable, timestamped, and pruned by a daily cron (keeping the newest build).
- **Deployment paths are pure configuration** — the `REPOSITORIES` route table maps
  `(host, path-prefix)` onto a release/snapshot repo, so you choose the public URLs.

## One-time Cloudflare setup

```sh
npm install

# 1. Create the R2 bucket (name must match wrangler.jsonc → r2_buckets.bucket_name)
npx wrangler r2 bucket create maven-artifacts

# 2. Create the D1 database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create maven

# 3. Apply the schema
npx wrangler d1 migrations apply maven --remote

# 4. Deploy
npx wrangler deploy
```

## Configuration (`wrangler.jsonc`)

| Setting                       | What to set                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `d1_databases[0].database_id` | **Required** — the id printed by `wrangler d1 create maven`.                  |
| `r2_buckets[0].bucket_name`   | The R2 bucket you created (`maven-artifacts`).                                |
| `vars.REPOSITORIES`           | The route table (below).                                                      |
| `routes`                      | Add when serving custom domains (below); omit to use the `*.workers.dev` URL. |
| `triggers.crons`              | Snapshot GC schedule (default daily `0 3 * * *`).                             |

### `REPOSITORIES` route table

Each entry maps a public mount to an internal repo. `host: "*"` matches any hostname; exact hosts
win over `*`, and the longest matching path prefix wins.

```jsonc
// Default (single host, /releases + /snapshots):
"vars": {
  "REPOSITORIES": [
    { "host": "*", "prefix": "/releases",  "repo": "release",  "r2Prefix": "releases" },
    { "host": "*", "prefix": "/snapshots", "repo": "snapshot", "r2Prefix": "snapshots" }
  ]
}
```

Custom domains (e.g. releases at `minestom.net/maven2`, snapshots at `snapshots.minestom.net`)
— set `REPOSITORIES` and add matching `routes` so Cloudflare sends those paths to the worker:

```jsonc
"routes": [
  { "pattern": "minestom.net/maven2/*", "zone_name": "minestom.net" },
  { "pattern": "snapshots.minestom.net/*", "zone_name": "minestom.net" }
],
"vars": {
  "REPOSITORIES": [
    { "host": "minestom.net",           "prefix": "/maven2", "repo": "release",  "r2Prefix": "releases" },
    { "host": "snapshots.minestom.net", "prefix": "/",       "repo": "snapshot", "r2Prefix": "snapshots" }
  ]
}
```

## Managing accounts (admin CLI)

Run against the remote DB (default) or add `--local` for the dev DB. The DB name comes from
`$MAVEN_DB` (default `maven`).

```sh
# Create an account and grant it a namespace
npm run admin -- create-account minestom --pgp-key ./minestom-public.asc
npm run admin -- add-namespace minestom net.minestom

# Mint a deploy key (printed once — store it as a CI secret)
npm run admin -- add-key minestom --label ci

# Rotate: add a new key, update CI, then revoke the old one
npm run admin -- add-key minestom --label ci-2
npm run admin -- revoke-key minestom ci

# A PGP public key is required to publish releases
npm run admin -- set-pgp-key minestom ./minestom-public.asc

npm run admin -- list-accounts
npm run admin -- list-keys minestom
```

Generate the PGP key pair with GnuPG and export the public key:
`gpg --gen-key` then `gpg --armor --export <key-id> > minestom-public.asc`. Sign artifacts in CI
with the matching private key (the maven-gpg-plugin or Gradle signing plugin).

## Publishing

Gradle (`build.gradle.kts`):

```kotlin
publishing {
  repositories {
    maven {
      url = uri(
        if (version.toString().endsWith("SNAPSHOT")) "https://snapshots.minestom.net"
        else                                          "https://minestom.net/maven2"
      )
      credentials {
        username = providers.environmentVariable("MAVEN_USERNAME").orNull   // "minestom"
        password = providers.environmentVariable("MAVEN_DEPLOY_KEY").orNull // the deploy key
      }
    }
  }
}
```

Consumers (public, no auth): `maven("https://minestom.net/maven2")`.

## Local development

```sh
npm run dev            # wrangler dev (local R2 + D1)
npm test               # vitest (unit + e2e) inside the Workers runtime via Miniflare
npm run test:coverage  # with coverage thresholds
npm run check          # fmt + lint + typecheck + test (what CI runs)
```

## CI/CD

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs format/lint/typecheck/test on every
PR and push to `main`, then deploys to Cloudflare on push to `main` (applying D1 migrations first).

Required **GitHub repository secrets**:

| Secret                  | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | API token with **Workers Scripts: Edit**, **D1: Edit**, **Workers R2 Storage: Edit**. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id.                                                           |

The deploy job uses a GitHub Environment named `production` (optional — add required reviewers
there if you want manual approval before deploys).

## Configuration summary

- **Cloudflare resources**: R2 bucket `maven-artifacts`, D1 database `maven`.
- **`wrangler.jsonc`**: real `database_id`, `REPOSITORIES`, optional `routes` for custom domains.
- **GitHub secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **Per account** (via the admin CLI, stored in D1): a PGP public key (for releases) and one or
  more deploy keys. No runtime Worker secrets are needed — keys are hashed and PGP keys are public.
