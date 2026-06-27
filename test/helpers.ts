import { env } from "cloudflare:test";
import { sha256Hex } from "../src/auth";

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

/** Wipe D1 tables and the R2 bucket so each test starts from a clean slate. */
export async function resetStorage(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifacts"),
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM namespaces"),
    env.DB.prepare("DELETE FROM deploy_keys"),
    env.DB.prepare("DELETE FROM accounts"),
  ]);
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ cursor, limit: 1000 });
    if (list.objects.length > 0) await env.BUCKET.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
