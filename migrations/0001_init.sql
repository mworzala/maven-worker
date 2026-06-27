-- Accounts: one per publisher. Owns namespaces + deploy keys, holds a PGP public key.
CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  public_pgp_key TEXT,
  created_at     INTEGER NOT NULL
);

-- Deploy keys: multiple per account for zero-downtime rotation. Only the hash is stored.
CREATE TABLE deploy_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL UNIQUE,
  label      TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_deploy_keys_hash ON deploy_keys(key_hash);

-- Namespace ownership: a groupId prefix an account may deploy under. Longest match wins.
CREATE TABLE namespaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  prefix     TEXT NOT NULL UNIQUE
);

-- Index of primary artifacts (jar/pom/classified). Source of record for metadata
-- generation, signature gating (`verified`), and snapshot GC (`deployed_at`).
CREATE TABLE artifacts (
  key         TEXT PRIMARY KEY,           -- full R2 key
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,              -- 'release' | 'snapshot'
  group_id    TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version     TEXT NOT NULL,              -- e.g. '1.5.0' or '1.6.0-SNAPSHOT'
  filename    TEXT NOT NULL,
  extension   TEXT NOT NULL,
  classifier  TEXT,
  verified    INTEGER NOT NULL DEFAULT 0, -- 1 once a valid .asc has been seen (releases)
  deployed_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_ga ON artifacts(repo, group_id, artifact_id, verified);
CREATE INDEX idx_artifacts_version ON artifacts(repo, group_id, artifact_id, version);
CREATE INDEX idx_artifacts_gc ON artifacts(repo, deployed_at);

-- Optional audit trail of writes.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  action     TEXT NOT NULL,
  path       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  ip         TEXT
);
