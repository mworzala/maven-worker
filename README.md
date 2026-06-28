# maven-worker

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

A self-hostable Maven repository running on **Cloudflare Workers**, with artifacts in **R2** and
accounts/index in **D1**. Public read, authenticated write, namespace ownership, signature-enforced
releases, immutable releases, and snapshot repositories with 90 day garbage-collection.

> **This is a GitHub template.** Click **Use this template**, run `npm run setup` (a guided wizard
> that creates your Cloudflare resources, writes the config, and sets the one CI secret), then push
> — CI applies the migrations and deploys your instance.

## Features

- **Public reads, authenticated writes** — `GET`/`HEAD` are open; `PUT` needs HTTP Basic auth
  (username = account, password = a deploy key).
- **Generated metadata & checksums** — `maven-metadata.xml` and all four checksums
  (`.md5`/`.sha1`/`.sha256`/`.sha512`) are computed from the D1 index on demand, never stored.
- **Namespace ownership** — an account may only deploy under groupId prefixes it owns.
- **Signature-enforced, immutable releases** — a release stays hidden until a valid PGP signature
  (`.asc`) verifies it, and published versions can't be overwritten.
- **Snapshot repositories** — mutable, timestamped, pruned by a daily cron (keeping the newest build).
- **Paths are pure configuration** — a `REPOSITORIES` route table maps `(host, path-prefix)` onto a
  release/snapshot repo, so you choose the public URLs (workers.dev or your own domain).
- **Rotatable deploy keys** — mint, label, and revoke keys per account; they're stored hashed.

---

## Deploy your own

### Prerequisites

- A **Cloudflare account** (the free plan is enough to start).
- **Node 22+** and a terminal.
- (optional) [`gh`](https://cli.github.com) authenticated (`gh auth login`) so setup can create the CI secrets.
- For publishing _releases_: **GnuPG** (to generate the signing key pair).

### 1. Create your repository

Click **Use this template → Create a new repository**, then clone it and install dependencies:

```sh
git clone https://github.com/<you>/<your-repo>.git
cd <your-repo>
npm install
```

### 2. Run the setup wizard

```sh
npx wrangler login   # authenticate this machine with Cloudflare
npm run setup
```

`npm run setup` walks you through the whole bootstrap and is safe to re-run:

1. **Confirms the Cloudflare account** (`wrangler whoami`; lets you pick if you have more than one).
2. **Creates** the R2 bucket and D1 database (skipping any that already exist).
3. **Writes `database_id` and `account_id` into `wrangler.jsonc`** for you — no manual editing.
4. **Sets the `CLOUDFLARE_API_TOKEN` GitHub secret** via `gh` (it links you to the token page and
   reads the token without echoing it). If `gh` isn't available it prints what to add by hand.
5. **Applies the D1 migrations**, optionally **creates your first publishing account** (printing a
   deploy key once), and records the template sync point for `npm run update`.

### 3. Commit and push

```sh
git commit -am "chore: configure deployment"
git push origin main
```

Make sure **Actions** are enabled on the new repo (**Settings → Actions → General**). The
[CI workflow](./.github/workflows/ci.yml) then runs format/lint/typecheck/test and, on `main`,
**applies migrations and deploys the Worker**. When it's green your instance is live at
`https://maven-worker.<your-subdomain>.workers.dev`.

> Prefer to do it by hand (or no `gh`)? Everything the wizard does is a plain `wrangler` command:
> `wrangler r2 bucket create maven-artifacts`, `wrangler d1 create maven` (paste the printed id and
> your account id into `wrangler.jsonc`), add the `CLOUDFLARE_API_TOKEN` repo secret, then push.

---

## Configuration (`wrangler.jsonc`)

| Setting                       | What to set                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `account_id`                  | Your Cloudflare account id. `npm run setup` fills this in.                      |
| `d1_databases[0].database_id` | The D1 database id. `npm run setup` fills this in.                              |
| `r2_buckets[0].bucket_name`   | The R2 bucket (`maven-artifacts`).                                              |
| `name`                        | The Worker name (also your `*.workers.dev` subdomain path). Rename if you like. |
| `vars.REPOSITORIES`           | The route table (below).                                                        |
| `routes`                      | Add when serving custom domains (below); omit to use the `*.workers.dev` URL.   |
| `triggers.crons`              | Snapshot GC schedule (default daily `0 3 * * *`).                               |

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

Custom domain (e.g. releases at `repo.example.com/releases`, snapshots at
`repo.example.com/snapshots`) — set `REPOSITORIES` and add a matching `route` so Cloudflare sends
that host to the worker. This requires the zone to be in your Cloudflare account:

```jsonc
"routes": [
  { "pattern": "repo.example.com/*", "zone_name": "example.com" }
],
"vars": {
  "REPOSITORIES": [
    { "host": "repo.example.com", "prefix": "/releases",  "repo": "release",  "r2Prefix": "releases" },
    { "host": "repo.example.com", "prefix": "/snapshots", "repo": "snapshot", "r2Prefix": "snapshots" }
  ]
}
```

## Managing accounts (admin CLI)

`npm run setup` can create your first publishing account; these commands manage the rest. Run
against the remote DB (default) or add `--local` for the dev DB. The DB name comes from `$MAVEN_DB`
(default `maven`).

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
        if (version.toString().endsWith("SNAPSHOT")) "https://repo.example.com/snapshots"
        else                                          "https://repo.example.com/releases"
      )
      credentials {
        username = providers.environmentVariable("MAVEN_USERNAME").orNull   // "minestom"
        password = providers.environmentVariable("MAVEN_DEPLOY_KEY").orNull // the deploy key
      }
    }
  }
}
```

Consumers (public, no auth): `maven("https://repo.example.com/releases")`.

## Local development

```sh
npm run dev            # wrangler dev (local R2 + D1)
npm test               # vitest (unit + e2e) inside the Workers runtime via Miniflare
npm run test:coverage  # with coverage thresholds
npm run check          # fmt + lint + typecheck + test (what CI runs)
```

`npm run dev` uses a preview R2 bucket; create it once with
`npx wrangler r2 bucket create maven-artifacts-preview` if you want local R2 to work.

## CI/CD

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs format/lint/typecheck/test on every
PR and push to `main`, then deploys to Cloudflare on push to `main` (applying D1 migrations first).
The deploy job uses a GitHub Environment named `production` — optional, but you can add required
reviewers there if you want a manual approval gate before deploys.

## How it works

- **Read** (`GET`/`HEAD`) is public. Artifacts stream from R2; `maven-metadata.xml` and all four
  checksums are **generated** from the D1 index on demand.
- **Write** (`PUT`) needs HTTP Basic auth — username = account name, password = a deploy key.
- **Namespaces**: an account may only deploy under groupId prefixes it owns.
- **Releases** are immutable and **hidden until a valid PGP signature** (`.asc`) verifies them.
- **Snapshots** are mutable, timestamped, and pruned by a daily cron (keeping the newest build).
- **Deployment paths are pure configuration** — the `REPOSITORIES` route table maps
  `(host, path-prefix)` onto a release/snapshot repo, so you choose the public URLs.

No runtime Worker secrets are needed — deploy keys are hashed and PGP keys are public.

## Updating from the template

A repository created from a template doesn't track this one, so it won't get later fixes (including
security fixes) automatically. Pull them in with:

```sh
npm run update
```

`update` fetches the upstream template and applies its changes to your working tree **while keeping
`wrangler.jsonc`** (your `database_id`, `account_id`, routes and `REPOSITORIES`), then records the
new sync point. It works even for "Use this template" repos that share no history with upstream. The
upstream URL is asked once and saved; `npm run setup` records the starting sync point for you.

Review the changes, run `npm install` (if dependencies changed) and `npm run check`, then commit. If
a hunk conflicts, resolve the markers, then run `npm run cli -- mark-synced` to record the sync
point. The set of protected paths is the `PROTECTED_PATHS` list at the top of
[`scripts/cli.mjs`](./scripts/cli.mjs).

</content>
</invoke>
