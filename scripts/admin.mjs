#!/usr/bin/env node
// Admin CLI for the maven worker. Manages accounts, deploy keys, namespaces and PGP keys by
// running SQL against the D1 database via `wrangler d1 execute`.
//
// Usage (append `--local` to target the local dev DB instead of `--remote`):
//   node scripts/admin.mjs create-account <name> [--pgp-key <file>]
//   node scripts/admin.mjs set-pgp-key <name> <file>
//   node scripts/admin.mjs add-namespace <name> <groupId-prefix>
//   node scripts/admin.mjs add-key <name> [--label <label>] [--expires <ISO8601>]
//   node scripts/admin.mjs revoke-key <name> <label>
//   node scripts/admin.mjs list-accounts
//   node scripts/admin.mjs list-keys <name>
//   node scripts/admin.mjs list-namespaces <name>
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = process.env.MAVEN_DB ?? "maven";
const argv = process.argv.slice(2);
const target = argv.includes("--local") ? "--local" : "--remote";

const positionals = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    if (a !== "--local" && a !== "--remote") i++; // skip the flag's value
    continue;
  }
  positionals.push(a);
}
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};

const sqlStr = (s) => `'${String(s).replaceAll("'", "''")}'`;
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const accountId = (name) => `(SELECT id FROM accounts WHERE name = ${sqlStr(name)})`;

function runSql(sql) {
  const file = join(tmpdir(), `maven-admin-${process.pid}-${Math.floor(performance.now())}.sql`);
  writeFileSync(file, sql);
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", DB, target, "--file", file], {
      stdio: "inherit",
    });
  } finally {
    unlinkSync(file);
  }
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const now = Date.now();
const cmd = argv[0];

switch (cmd) {
  case "create-account": {
    const name = positionals[0] ?? die("create-account <name>");
    const keyFile = flag("pgp-key");
    const pgp = keyFile ? sqlStr(readFileSync(keyFile, "utf8")) : "NULL";
    runSql(
      `INSERT INTO accounts (name, public_pgp_key, created_at) VALUES (${sqlStr(name)}, ${pgp}, ${now});`,
    );
    break;
  }
  case "set-pgp-key": {
    const name = positionals[0] ?? die("set-pgp-key <name> <file>");
    const file = positionals[1] ?? die("set-pgp-key <name> <file>");
    runSql(
      `UPDATE accounts SET public_pgp_key = ${sqlStr(readFileSync(file, "utf8"))} WHERE name = ${sqlStr(name)};`,
    );
    break;
  }
  case "add-namespace": {
    const name = positionals[0] ?? die("add-namespace <name> <prefix>");
    const prefix = positionals[1] ?? die("add-namespace <name> <prefix>");
    runSql(
      `INSERT INTO namespaces (account_id, prefix) VALUES (${accountId(name)}, ${sqlStr(prefix)});`,
    );
    break;
  }
  case "add-key": {
    const name = positionals[0] ?? die("add-key <name> [--label <l>] [--expires <ISO>]");
    const label = flag("label") ?? "default";
    const expiresIso = flag("expires");
    const expires = expiresIso ? String(Date.parse(expiresIso)) : "NULL";
    if (expires === "NaN") die(`invalid --expires date: ${expiresIso}`);
    const token = randomBytes(24).toString("base64url");
    runSql(
      `INSERT INTO deploy_keys (account_id, key_hash, label, created_at, expires_at, revoked_at)
       VALUES (${accountId(name)}, ${sqlStr(sha256Hex(token))}, ${sqlStr(label)}, ${now}, ${expires}, NULL);`,
    );
    console.log(
      `\nDeploy key for '${name}' (label '${label}') — store it now, it is not recoverable:\n`,
    );
    console.log(`  ${token}\n`);
    break;
  }
  case "revoke-key": {
    const name = positionals[0] ?? die("revoke-key <name> <label>");
    const label = positionals[1] ?? die("revoke-key <name> <label>");
    runSql(
      `UPDATE deploy_keys SET revoked_at = ${now}
       WHERE label = ${sqlStr(label)} AND revoked_at IS NULL AND account_id = ${accountId(name)};`,
    );
    break;
  }
  case "list-accounts":
    runSql(
      "SELECT id, name, (public_pgp_key IS NOT NULL) AS has_pgp_key, created_at FROM accounts;",
    );
    break;
  case "list-keys": {
    const name = positionals[0] ?? die("list-keys <name>");
    runSql(
      `SELECT label, created_at, expires_at, revoked_at FROM deploy_keys WHERE account_id = ${accountId(name)};`,
    );
    break;
  }
  case "list-namespaces": {
    const name = positionals[0] ?? die("list-namespaces <name>");
    runSql(`SELECT prefix FROM namespaces WHERE account_id = ${accountId(name)};`);
    break;
  }
  default:
    die(`unknown command '${cmd ?? ""}'. See the header of scripts/admin.mjs for usage.`);
}
