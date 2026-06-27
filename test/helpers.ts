import { env } from "cloudflare:test";
import * as openpgp from "openpgp";
import { sha256Hex } from "../src/auth";
import type { RepoKind } from "../src/types";

export async function createAccount(
  name: string,
  opts: { publicPgpKey?: string } = {},
): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO accounts (name, public_pgp_key, created_at) VALUES (?1, ?2, ?3)",
  )
    .bind(name, opts.publicPgpKey ?? null, Date.now())
    .run();
  return res.meta.last_row_id;
}

export async function addKey(
  accountId: number,
  key: string,
  opts: { label?: string; expiresAt?: number | null; revokedAt?: number | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deploy_keys (account_id, key_hash, label, created_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      accountId,
      await sha256Hex(key),
      opts.label ?? "default",
      Date.now(),
      opts.expiresAt ?? null,
      opts.revokedAt ?? null,
    )
    .run();
}

export async function addNamespace(accountId: number, prefix: string): Promise<void> {
  await env.DB.prepare("INSERT INTO namespaces (account_id, prefix) VALUES (?1, ?2)")
    .bind(accountId, prefix)
    .run();
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export interface SeedArtifactOpts {
  key: string;
  accountId?: number;
  repo: RepoKind;
  groupId: string;
  artifactId: string;
  version: string;
  filename: string;
  extension?: string;
  classifier?: string | null;
  verified?: number;
  deployedAt?: number;
  body?: string;
}

/** Directly insert an artifact index row (and optionally its R2 object). */
export async function seedArtifact(o: SeedArtifactOpts): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO artifacts
      (key, account_id, repo, group_id, artifact_id, version, filename, extension, classifier, verified, deployed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      o.key,
      o.accountId ?? 1,
      o.repo,
      o.groupId,
      o.artifactId,
      o.version,
      o.filename,
      o.extension ?? "jar",
      o.classifier ?? null,
      o.verified ?? 1,
      o.deployedAt ?? Date.now(),
    )
    .run();
  if (o.body !== undefined) await env.BUCKET.put(o.key, o.body);
}

export async function generateKeypair(
  name = "Test",
): Promise<{ publicKey: string; privateKey: string }> {
  const { publicKey, privateKey } = await openpgp.generateKey({
    userIDs: [{ name }],
    format: "armored",
  });
  return { publicKey, privateKey };
}

/** Produce an armored detached signature of `body` with the given private key. */
export async function signDetached(privateKeyArmored: string, body: string): Promise<string> {
  const signingKeys = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  const message = await openpgp.createMessage({ binary: new TextEncoder().encode(body) });
  return openpgp.sign({ message, signingKeys, detached: true, format: "armored" });
}

/** Wipe D1 tables and the R2 bucket so each test starts from a clean slate. */
export async function resetStorage(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifacts"),
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM namespaces"),
    env.DB.prepare("DELETE FROM deploy_keys"),
    env.DB.prepare("DELETE FROM accounts"),
    // Reset AUTOINCREMENT so the first inserted account is id 1.
    env.DB.prepare("DELETE FROM sqlite_sequence"),
  ]);
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ cursor, limit: 1000 });
    if (list.objects.length > 0) await env.BUCKET.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
