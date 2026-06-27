# Maven Repository on Cloudflare Workers — Plan

A self-hostable Maven repository (like Maven Central) implemented as a Cloudflare Worker in
TypeScript, backed by R2 for artifact storage and D1 for accounts/namespaces/index. **Public
read, authenticated write** via rotatable deploy keys, with **namespace ownership** so multiple
accounts can share one repository safely, and **signature-enforced releases**. Operators run
their own copy of the Worker (open-source / `wrangler deploy`).

Status: **planning**. Decisions in §9.

---

## 1. What a Maven repository actually is

A Maven repo is **a plain HTTP file server with a strict path layout plus a few generated XML
index files**. Maven clients (the `maven-resolver` transport used by `mvn` and Gradle) speak
ordinary HTTP:

| Method              | Use                                                                      |
| ------------------- | ------------------------------------------------------------------------ |
| `GET`               | download an artifact, checksum, signature, or metadata file              |
| `HEAD`              | existence / freshness check                                              |
| `PUT`               | deploy a file (auth required)                                            |
| `OPTIONS` / `MKCOL` | only old `wagon-webdav` transports; **modern Maven does not need these** |

Minimum viable server: route by path, `GET`/`HEAD` from R2, `PUT` to R2 with auth. Metadata,
checksums, and signatures are layered policy.

### 1.1 Repository layout

The path is derived mechanically from coordinates `groupId:artifactId:version[:classifier]:extension`:

```
<mount>/<groupId with '.' → '/'>/<artifactId>/<version>/<artifactId>-<version>[-<classifier>].<ext>
```

`<mount>` is whatever public prefix maps to a repo (§7). Example for `net.minestom:minestom:1.5.0`
on the release repo, internal R2 prefix `releases/`:

```
releases/net/minestom/minestom/                       maven-metadata.xml   ← versions list (we generate)
releases/net/minestom/minestom/1.5.0/minestom-1.5.0.pom   (+ .sha1 .md5 .sha256 .sha512 [.asc])
releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar
releases/net/minestom/minestom/1.5.0/minestom-1.5.0-sources.jar
```

Every real file is shadowed by **checksum files** (separate objects) and a `.asc` **detached
PGP signature** (required for releases, §8.2). The R2 key is the internal repo prefix + the
Maven coordinate path.

### 1.2 The two `maven-metadata.xml` files

**(a) Group/artifact level** — `…/minestom/maven-metadata.xml` — lists released versions:

```xml
<metadata>
  <groupId>net.minestom</groupId><artifactId>minestom</artifactId>
  <versioning>
    <latest>1.5.0</latest><release>1.5.0</release>
    <versions><version>1.4.0</version><version>1.5.0</version></versions>
    <lastUpdated>20260627000000</lastUpdated>
  </versioning>
</metadata>
```

**(b) Version level (SNAPSHOTS only)** — `…/minestom/1.6.0-SNAPSHOT/maven-metadata.xml` —
maps the logical `-SNAPSHOT` to the concrete timestamped build:

```xml
<versioning><snapshot><timestamp>20260627.101500</timestamp><buildNumber>3</buildNumber></snapshot>
  <snapshotVersions><snapshotVersion>
    <extension>jar</extension><value>1.6.0-20260627.101500-3</value><updated>20260627101500</updated>
  </snapshotVersion> … </snapshotVersions>
</versioning>
```

**We generate both ourselves** from the D1 index (§6), never trusting client uploads.

### 1.3 Snapshots — unique timestamps are mandatory

Modern Maven deploys snapshots as `minestom-1.6.0-20260627.101500-3.jar` and uses the
version-level metadata to point at the newest. The server must accept timestamped filenames and
serve correct version-level metadata.

### 1.4 Checksums & signatures

- **Generate all four** (`.md5`, `.sha1`, `.sha256`, `.sha512`) ourselves from the object
  contents; **serve whichever extension is requested**. Ignore client-uploaded checksums.
- `.asc` detached PGP signatures are verified in-Worker (§8.2).

---

## 2. Cloudflare platform constraints (verified June 2026)

| Constraint                   | Value                                                                           | Impact                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker request body size** | **100 MB Free/Pro · 200 MB Business · 500 MB+ Enterprise** (per _account_ plan) | **Hard cap on a single `mvn deploy` PUT.** Maven does one PUT per file with no multipart, so no clean workaround. Big shaded/native JARs may not fit on Free/Pro. |
| R2 max object size           | ~4.995 TiB                                                                      | Not the bottleneck.                                                                                                                                               |
| R2 single PUT                | ~4.995 GiB; multipart for larger                                                | Worker streams `request.body` straight into `bucket.put()` — no buffering — but the edge body cap still applies.                                                  |
| Worker CPU time              | 30 s default (paid), up to 5 min                                                | Streaming I/O isn't CPU; hashing/PGP of large files is. `crypto.DigestStream` hashes a stream natively.                                                           |
| Web Crypto / `openpgp.js`    | available                                                                       | Stream-hash + verify detached PGP signatures without buffering (§8.2).                                                                                            |
| D1                           | SQLite                                                                          | Accounts, key hashes, namespaces, artifact index (metadata + verification + GC), audit log.                                                                       |
| KV / Cache API               | edge cache                                                                      | Cache generated metadata + hot reads.                                                                                                                             |

**Feasibility: comfortable.** The only real wart is the request-body cap for unusually large
artifacts, which is a Cloudflare _plan_ choice, not a design flaw.

---

## 3. Architecture

```
        ┌──────────── Cloudflare edge ────────────┐
mvn ──▶  │  Worker (TS)                            │
gradle   │   • route table: (host,prefix)→repo     │──▶  R2 bucket  (artifacts, checksums, .asc)
         │   • auth (Basic → deploy-key hash)      │
         │   • namespace authorization             │──▶  D1  (accounts, key hashes, namespaces,
         │   • policy: immutability, size, layout  │         artifact index: verified + deployed_at,
         │   • PGP verify → visibility gate        │         audit log)
         │   • metadata gen from D1 index          │
         │   • GET/HEAD/PUT + HTML browse index    │──▶  Cache API / KV  (generated metadata)
         │   Cron trigger → snapshot GC (90 d)     │
         └─────────────────────────────────────────┘
```

- **Single R2 bucket**, key = internal repo prefix + coordinate path. `releases/…` is immutable
  - signature-gated; `snapshots/…` is mutable + GC'd.
- **Worker stays in front of R2** (not a public bucket) so we control auth, immutability,
  metadata, signature gating, and caching.
- **D1 is the index of record** for primary artifacts (jar/pom/classified): each row carries
  `verified` and `deployed_at`, which drives metadata generation, signature gating, and GC in
  one place. Checksums/signatures/metadata files are not indexed (derived/served on the fly).
- **Admin = scripts** (`wrangler` + D1 SQL); no admin API for now.

---

## 4. Accounts, deploy keys & namespace ownership

- An **account** owns one or more **namespace prefixes** (e.g. `net.minestom`). A deploy is
  authorized only when the target groupId falls under a prefix the account owns — lets multiple
  accounts share one repo without clobbering each other (longest-prefix match wins).
- **Deploy keys**: high-entropy random tokens, sent as the **password** in HTTP Basic auth
  (`Authorization: Basic base64(account:key)`) — exactly what Maven/Gradle send. Store only a
  **hash** (SHA-256 of the token); compare on auth.
- **Safe rotation**: an account holds **multiple active keys**, each with a label + optional
  expiry. Add new key → update CI → revoke old one ⇒ zero-downtime rotation. Revocation is
  immediate.
- Each account registers a **public PGP key** (required to deploy releases, §8.2).
- **Read is public**: no auth on `GET`/`HEAD`. No private namespaces/artifacts in scope.
- D1 schema sketch:
  ```sql
  accounts(id, name UNIQUE, created_at, public_pgp_key NULL, settings JSON)
  deploy_keys(id, account_id, key_hash UNIQUE, label, created_at, expires_at NULL, revoked_at NULL)
  namespaces(id, account_id, prefix UNIQUE)              -- prefix = groupId, longest-match wins
  artifacts(key PRIMARY KEY, account_id, repo,           -- one row per primary artifact file
            group_id, artifact_id, version, filename,
            verified INT DEFAULT 0, deployed_at)          -- drives metadata, sig-gate, GC
  audit_log(id, account_id, action, path, ts, ip)        -- optional
  ```

---

## 5. Core request handling

1. **Resolve repo** from the route table: match `(host, path-prefix)` → `{repo, r2Prefix}` (§7),
   strip the mount prefix.
2. **Parse path** into Maven coordinates; reject anything not valid layout (defends the bucket).
3. **GET/HEAD** (no auth): metadata + checksum requests are produced by the generator (§6);
   artifact requests serve the R2 object **only if its `artifacts` row is `verified`** (release
   repos) — pending artifacts return `404`. Correct `Content-Type`, `ETag`, `Last-Modified`,
   `If-None-Match`, `Range`; cache release objects hard, metadata short.
4. **PUT** (auth): authenticate key → authorize namespace → enforce policy (immutability §8.1,
   size, base/version-suffix agreement) → stream `request.body` into `bucket.put(key)`, upsert
   the D1 `artifacts` row (pending). `maven-metadata.xml` + checksums are **accepted (200) and
   discarded** (we serve generated versions). `.asc` PUT triggers verification (§8.2).
5. **Directory request** (trailing `/` or extensionless): generate an **HTML browse index** from
   the D1 index / R2 `list`. The Lucene/Nexus **search index** is out of scope.

---

## 6. Metadata generation (we own it)

Generated from the **D1 `artifacts` index**, filtered to `verified=1` for release repos:

- On `PUT` of `maven-metadata.xml`/checksums → `200` + discard.
- On `GET` of group-level metadata → `SELECT` verified versions for that `(repo, group, artifact)`,
  emit `<versions>`/`<latest>`/`<release>`/`<lastUpdated>`. Cache (short TTL).
- On `GET` of snapshot version-level metadata → select that `…-SNAPSHOT` dir's verified builds,
  parse `<base>-<yyyyMMdd.HHmmss>-<buildNumber>`, take newest, emit `<snapshot>` +
  `<snapshotVersions>` per extension/classifier.
- Generate the metadata's `.md5/.sha1/.sha256/.sha512` from the bytes we just produced → always
  mutually consistent.
- **Why D1-driven:** no metadata races between concurrent deploys, the listing only ever shows
  verified/signed artifacts (this _is_ the signature gate, §8.2), and generation is one SQL query.

---

## 7. Routing & repository mapping

The worker holds a small **route table** mapping `(host, path-prefix) → {repo, r2Prefix}`. This
decouples the public URL from internal storage. `/maven2` is a Central _convention_, not a
requirement — a Maven base URL is arbitrary, so you can mount repos at pretty URLs with
**Cloudflare Workers Routes**.

### Worked example — Minestom on its own domain

Goal: releases at `https://minestom.net/maven2`, snapshots at `https://snapshots.minestom.net`,
without disturbing the `minestom.net` website.

`wrangler.toml` routes + worker config:

```
routes = [ "minestom.net/maven2/*", "snapshots.minestom.net/*" ]

# route table (env / D1):
#   minestom.net           /maven2  ->  { repo: release,  r2Prefix: "releases" }
#   snapshots.minestom.net /        ->  { repo: snapshot, r2Prefix: "snapshots" }
```

Only `/maven2/*` is routed to the worker; the rest of `minestom.net` hits the website origin as
usual. Requires `minestom.net` on Cloudflare with proxied DNS. Self-hosters who don't want pretty
URLs just map one host's `/releases` and `/snapshots` prefixes.

**Publisher** (`build.gradle.kts`; `minestom` account owns `net.minestom`, holds a deploy key):

```kotlin
plugins { `maven-publish` }
publishing {
    publications { create<MavenPublication>("maven") { from(components["java"]) } }
    repositories {
        maven {
            name = "minestom"
            url = uri(
                if (version.toString().endsWith("SNAPSHOT")) "https://snapshots.minestom.net"
                else                                          "https://minestom.net/maven2"
            )
            credentials {
                username = providers.environmentVariable("MAVEN_USERNAME").orNull   // "minestom"
                password = providers.environmentVariable("MAVEN_DEPLOY_KEY").orNull // rotatable key
            }
        }
    }
}
```

Maven equivalent: `<distributionManagement>` with `<repository>`=`https://minestom.net/maven2`
and `<snapshotRepository>`=`https://snapshots.minestom.net`, matching `<server>` creds in
`settings.xml`.

**Consumers** (public, no auth):

```kotlin
repositories { maven("https://minestom.net/maven2") }     // or https://snapshots.minestom.net
```

Resolved URL for a release: `https://minestom.net/maven2/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`
→ internal R2 key `releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`.

**Deploy flow:** for each file the client sends `PUT …/<file>` then `.sha1/.md5` (we discard
checksums) with `Authorization: Basic`. The worker authenticates the key, checks `net.minestom`
is owned by the `minestom` account, enforces immutability on releases, streams each body into R2,
and upserts the D1 row (pending). The `.jar.asc`/`.pom.asc` PUTs trigger signature verification
and flip the rows to verified (§8.2).

---

## 8. Policy: immutability, signatures, GC

### 8.1 Immutable releases — **in MVP**

`PUT` to a release coordinate path that already exists → **409 Conflict**. Generated metadata is
never client-stored. Snapshots are exempt (mutable by definition).

### 8.2 Signatures — **enforced on releases**

**Verification is possible on Workers:** `openpgp.js` (runs on Web Crypto) verifies the detached
`.asc`; stream the artifact from R2 as a Web Stream into `verify()` (or hash via
`crypto.DigestStream`) so large jars aren't buffered — one full-file hash + one public-key verify
per artifact.

**Enforcement = visibility gated on a valid signature** (plain `mvn deploy` UX, no staging):

- Each account registers a **public PGP key**; required to deploy releases.
- A primary artifact PUT to a release repo is stored but **pending** (`404` to consumers, absent
  from metadata).
- Its `.asc` PUT → verify against the account key: **valid → verified** (downloadable + listed);
  **invalid → `400` + delete** the artifact and the bad signature.
- A never-validly-signed artifact stays pending forever → never served. ⇒ consumers can only ever
  see signed releases.
- **Snapshots are not signature-gated** (common practice; Central doesn't host snapshots).
- _Rejected alternatives:_ verify-on-arrival only (can't guarantee a sig is uploaded) is weaker;
  full staging+finalize (Durable Object alarm or finalize call) is more robust/atomic but heavier.

### 8.3 Snapshot GC — Cron trigger, 90 days, keep newest

Daily Cron selects `artifacts` rows where `repo=snapshot` and `deployed_at` older than 90 days,
deletes their R2 objects + rows, **but always keeps the newest build per `…-SNAPSHOT`** so a
referenced snapshot never fully disappears. D1-driven → no R2 scan.

---

## 9. Decisions

**Locked:**

1. Drop custom CNAMEs / Cloudflare for SaaS — operators self-host; repo is public.
2. Metadata generated by us, from the D1 index (§6). Not dumb-store.
3. Public read, authenticated write. No private namespaces/artifacts.
4. **Configurable route table** mapping `(host, path-prefix) → repo` via Workers Routes (§7);
   default self-host uses `/releases` + `/snapshots`, Minestom uses `minestom.net/maven2` +
   `snapshots.minestom.net`.
5. Admin surface = scripts (`wrangler` + D1 SQL).
6. Multiple accounts + namespace ownership + multi-key rotation (§4).
7. Immutable releases (409 on re-publish).
8. **Signatures enforced on releases** via visibility-gating + in-Worker `openpgp.js` verify
   against a per-account public key (§8.2). Snapshots not gated.
9. **Generate all four checksums** (md5/sha1/sha256/sha512), serve whichever is requested.
10. Snapshot GC = age 90 d **+ keep newest build** (§8.3).

---

## 10. Proposed milestones

- **M0 — skeleton**: Worker + R2 + `wrangler` config + route table + path parsing/validation +
  `GET`/`HEAD` streaming with content types & caching. (Read-only mirror works.)
- **M1 — auth & deploy**: D1 accounts + hashed deploy keys + namespace ownership + Basic auth +
  `PUT` + immutable releases + D1 artifact index. Real `mvn`/Gradle deploy works (pre-gating).
- **M2 — metadata & browse**: generate group/version metadata + all-four checksums from the D1
  index + HTML directory index.
- **M3 — signatures**: account public keys + `openpgp.js` detached verify + visibility gating on
  releases. (Required before "production" releases.)
- **M4 — snapshots GC**: Cron trigger (90 d + keep newest) over the D1 index.

---

## 11. Risks & watch-items

- **Request body cap** limits single-artifact size on Free/Pro (100 MB); no multipart escape
  hatch via stock Maven. Surface clearly.
- **`openpgp.js` on Workers** — validate early (streaming verify + Web Crypto support, bundle
  size). Have `crypto.DigestStream` as the hashing primitive.
- **PGP/hash CPU** on very large artifacts vs the CPU ceiling.
- **Metadata cache invalidation** on deploy — short TTL / purge so fresh deploys appear promptly.
- **Maven/Gradle client quirks** (checksum extensions, `HEAD`, redirects, signature upload
  ordering) — test against real `mvn deploy` _and_ Gradle `publish` early.
