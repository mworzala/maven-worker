import type { RepoKind } from "./types";

export interface Account {
  id: number;
  name: string;
  publicPgpKey: string | null;
}

export interface ArtifactRow {
  key: string;
  accountId: number;
  repo: RepoKind;
  groupId: string;
  artifactId: string;
  version: string;
  filename: string;
  extension: string;
  classifier: string | null;
  verified: number;
  deployedAt: number;
}

/** Authenticate a `(username, key)` pair: resolve the account if the key is live. */
export async function authenticate(
  db: D1Database,
  username: string,
  keyHash: string,
  now: number,
): Promise<Account | null> {
  const row = await db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.public_pgp_key AS publicPgpKey
       FROM deploy_keys k JOIN accounts a ON a.id = k.account_id
       WHERE k.key_hash = ?1 AND a.name = ?2
         AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?3)`,
    )
    .bind(keyHash, username, now)
    .first<{ id: number; name: string; publicPgpKey: string | null }>();
  return row ?? null;
}

/** All namespace prefixes an account owns. */
export async function ownedPrefixes(db: D1Database, accountId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT prefix FROM namespaces WHERE account_id = ?1")
    .bind(accountId)
    .all<{ prefix: string }>();
  return results.map((r) => r.prefix);
}

/** Whether a groupId falls under any owned prefix (exact or dotted-prefix match). */
export function accountOwnsGroup(prefixes: string[], groupId: string): boolean {
  return prefixes.some((p) => groupId === p || groupId.startsWith(`${p}.`));
}

/** Insert or replace the index row for a primary artifact. */
export async function recordArtifact(db: D1Database, row: ArtifactRow): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO artifacts
        (key, account_id, repo, group_id, artifact_id, version, filename, extension, classifier, verified, deployed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      row.key,
      row.accountId,
      row.repo,
      row.groupId,
      row.artifactId,
      row.version,
      row.filename,
      row.extension,
      row.classifier,
      row.verified,
      row.deployedAt,
    )
    .run();
}

export interface VersionRow {
  version: string;
  updated: number;
}

/** Distinct verified versions of an artifact in a repo, oldest deploy first. */
export async function listVersions(
  db: D1Database,
  repo: RepoKind,
  groupId: string,
  artifactId: string,
): Promise<VersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT version, MAX(deployed_at) AS updated FROM artifacts
       WHERE repo = ?1 AND group_id = ?2 AND artifact_id = ?3 AND verified = 1
       GROUP BY version ORDER BY updated ASC`,
    )
    .bind(repo, groupId, artifactId)
    .all<VersionRow>();
  return results;
}

/** All verified files of a single snapshot version. */
export async function listSnapshotArtifacts(
  db: D1Database,
  repo: RepoKind,
  groupId: string,
  artifactId: string,
  version: string,
): Promise<ArtifactRow[]> {
  const { results } = await db
    .prepare(
      `SELECT key, account_id AS accountId, repo, group_id AS groupId, artifact_id AS artifactId,
              version, filename, extension, classifier, verified, deployed_at AS deployedAt
       FROM artifacts
       WHERE repo = ?1 AND group_id = ?2 AND artifact_id = ?3 AND version = ?4 AND verified = 1`,
    )
    .bind(repo, groupId, artifactId, version)
    .all<ArtifactRow>();
  return results;
}

export async function getArtifact(db: D1Database, key: string): Promise<ArtifactRow | null> {
  const row = await db
    .prepare(
      `SELECT key, account_id AS accountId, repo, group_id AS groupId, artifact_id AS artifactId,
              version, filename, extension, classifier, verified, deployed_at AS deployedAt
       FROM artifacts WHERE key = ?1`,
    )
    .bind(key)
    .first<ArtifactRow>();
  return row ?? null;
}

export async function deleteArtifact(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM artifacts WHERE key = ?1").bind(key).run();
}

export async function markVerified(db: D1Database, key: string): Promise<void> {
  await db.prepare("UPDATE artifacts SET verified = 1 WHERE key = ?1").bind(key).run();
}

export async function insertAudit(
  db: D1Database,
  accountId: number | null,
  action: string,
  path: string,
  now: number,
  ip: string | null,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (account_id, action, path, ts, ip) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(accountId, action, path, now, ip)
    .run();
}
