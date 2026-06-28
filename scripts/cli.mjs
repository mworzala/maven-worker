#!/usr/bin/env node
// Combined CLI for the maven worker.
//
//   node scripts/cli.mjs setup                 first-time guided setup (resources, config, secret)
//   node scripts/cli.mjs update [--from <sha>] pull template (upstream) fixes, keeping wrangler.jsonc
//   node scripts/cli.mjs mark-synced           record the current upstream as the template sync point
//
// Account/key admin (append `--local` to target the dev DB instead of `--remote`):
//   node scripts/cli.mjs create-account <name> [--pgp-key <file>]
//   node scripts/cli.mjs set-pgp-key <name> <file>
//   node scripts/cli.mjs add-namespace <name> <groupId-prefix>
//   node scripts/cli.mjs add-key <name> [--label <label>] [--expires <ISO8601>]
//   node scripts/cli.mjs revoke-key <name> <label>
//   node scripts/cli.mjs list-accounts | list-keys <name> | list-namespaces <name>
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

// ── configuration ───────────────────────────────────────────────────────────
const TEMPLATE_REPO_DEFAULT = "https://github.com/hollowcube/maven-worker.git";
const WRANGLER_CONFIG = "wrangler.jsonc";
const DB_PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID";
const ACCOUNT_PLACEHOLDER = "REPLACE_WITH_ACCOUNT_ID";
const PROTECTED_PATHS = ["wrangler.jsonc"]; // never overwritten by `update`

const DB = process.env.MAVEN_DB ?? "maven";
const BUCKET = process.env.MAVEN_BUCKET ?? "maven-artifacts";

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const target = argv.includes("--local") ? "--local" : "--remote";
const now = Date.now();

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

// ── small helpers ─────────────────────────────────────────────────────────────
const log = (m = "") => console.log(m);
const step = (m) => console.log(`\n• ${m}`);
function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

let selectedAccountId;
const env = () =>
  selectedAccountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: selectedAccountId } : process.env;

// Run a command, capturing stdout. Throws on non-zero exit.
const capture = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: "utf8", ...opts });
// Run a command, inheriting stdio (for interactive/streamed output).
const run = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: "inherit", ...opts });
// Run a command, never throwing: returns { ok, out }.
function attempt(bin, args, opts = {}) {
  try {
    return { ok: true, out: capture(bin, args, opts) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}
const wrangler = (args, opts = {}) =>
  attempt("npx", ["wrangler", ...args], { env: env(), ...opts });
const git = (args, opts = {}) => attempt("git", args, opts);

function parseJsonArray(out) {
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  if (start < 0 || end < start) die("expected JSON array from wrangler");
  return JSON.parse(out.slice(start, end + 1));
}

// ── prompts (lazy readline so non-interactive commands don't hang) ────────────
let readline;
const rl = () => (readline ??= createInterface({ input: stdin, output: stdout }));
const closeRl = () => {
  readline?.close();
  readline = undefined;
};
const ask = async (q, def) => {
  const a = (await rl().question(def ? `${q} [${def}] ` : `${q} `)).trim();
  return a || def || "";
};
async function confirm(q, def = false) {
  const a = (await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}
async function askHidden(query) {
  const r = rl();
  const sink = "_writeToOutput"; // readline's echo hook; muting it hides the typed token
  const original = r[sink] ?? ((s) => stdout.write(s));
  let shown = false;
  r[sink] = (str) => {
    if (!shown) {
      stdout.write(str);
      if (str.includes(query)) shown = true;
      return;
    }
    if (str.includes("\n")) stdout.write("\n");
  };
  const answer = await r.question(`${query} `);
  r[sink] = original;
  return answer.trim();
}

// ── SQL / admin actions (shared by the dispatcher and the setup wizard) ───────
const sqlStr = (s) => `'${String(s).replaceAll("'", "''")}'`;
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const accountId = (name) => `(SELECT id FROM accounts WHERE name = ${sqlStr(name)})`;

function runSql(sql) {
  const file = join(tmpdir(), `maven-admin-${process.pid}-${Math.floor(performance.now())}.sql`);
  writeFileSync(file, sql);
  try {
    run("npx", ["wrangler", "d1", "execute", DB, target, "--file", file], { env: env() });
  } finally {
    unlinkSync(file);
  }
}

function createAccount(name, keyFile) {
  const pgp = keyFile ? sqlStr(readFileSync(keyFile, "utf8")) : "NULL";
  runSql(
    `INSERT INTO accounts (name, public_pgp_key, created_at) VALUES (${sqlStr(name)}, ${pgp}, ${now});`,
  );
}
function setPgpKey(name, file) {
  runSql(
    `UPDATE accounts SET public_pgp_key = ${sqlStr(readFileSync(file, "utf8"))} WHERE name = ${sqlStr(name)};`,
  );
}
function addNamespace(name, prefix) {
  runSql(
    `INSERT INTO namespaces (account_id, prefix) VALUES (${accountId(name)}, ${sqlStr(prefix)});`,
  );
}
function addKey(name, label = "default", expiresIso) {
  const expires = expiresIso ? String(Date.parse(expiresIso)) : "NULL";
  if (expires === "NaN") die(`invalid --expires date: ${expiresIso}`);
  const token = randomBytes(24).toString("base64url");
  runSql(
    `INSERT INTO deploy_keys (account_id, key_hash, label, created_at, expires_at, revoked_at)
     VALUES (${accountId(name)}, ${sqlStr(sha256Hex(token))}, ${sqlStr(label)}, ${now}, ${expires}, NULL);`,
  );
  return token;
}
function revokeKey(name, label) {
  runSql(
    `UPDATE deploy_keys SET revoked_at = ${now}
     WHERE label = ${sqlStr(label)} AND revoked_at IS NULL AND account_id = ${accountId(name)};`,
  );
}
function printKey(name, label, token) {
  log(`\nDeploy key for '${name}' (label '${label}') — store it now, it is not recoverable:\n`);
  log(`  ${token}\n`);
}

// ── setup wizard ──────────────────────────────────────────────────────────────
function listCloudflareAccounts() {
  const r = attempt("npx", ["wrangler", "whoami"]);
  const accounts = [];
  for (const line of r.out.split("\n")) {
    const m = line.match(/([\da-f]{32})/i);
    if (m) {
      const name = line.replaceAll("│", " ").replace(m[1], "").replaceAll(/\s+/g, " ").trim();
      accounts.push({ name: name || "(unnamed)", id: m[1] });
    }
  }
  return { text: r.out, accounts };
}

async function chooseAccount() {
  const { text, accounts } = listCloudflareAccounts();
  if (accounts.length === 0) {
    log(text);
    die("not logged in to wrangler — run `npx wrangler login`, then re-run setup");
  }
  let chosen = accounts[0];
  if (accounts.length === 1) {
    if (!(await confirm(`Use Cloudflare account '${chosen.name}' (${chosen.id})?`, true))) {
      die("aborted — switch with `npx wrangler logout` then `login`, then re-run setup");
    }
  } else {
    log("Multiple Cloudflare accounts are available:");
    for (const [i, a] of accounts.entries()) log(`  ${i + 1}. ${a.name} (${a.id})`);
    const pick = Number(await ask("Which account? (number)", "1"));
    chosen = accounts[pick - 1] ?? die("invalid selection");
  }
  return chosen;
}

function ensureBucket() {
  const r = wrangler(["r2", "bucket", "create", BUCKET]);
  if (r.ok) return log(`  created R2 bucket '${BUCKET}'`);
  if (/already|exists|owned/i.test(r.out)) return log(`  R2 bucket '${BUCKET}' already exists`);
  log(r.out);
  die(`failed to create R2 bucket '${BUCKET}'`);
}

function ensureDatabase() {
  const created = wrangler(["d1", "create", DB]);
  if (!created.ok && !/already exists/i.test(created.out)) {
    log(created.out);
    die(`failed to create D1 database '${DB}'`);
  }
  const listed = wrangler(["d1", "list", "--json"]);
  if (!listed.ok) {
    log(listed.out);
    die("failed to list D1 databases");
  }
  const row = parseJsonArray(listed.out).find((d) => (d.name ?? d.database_name) === DB);
  const id = row?.uuid ?? row?.database_id;
  if (!id) die(`could not resolve the id of D1 database '${DB}'`);
  log(`  D1 database '${DB}' → ${id}`);
  return id;
}

function patchWranglerConfig(replacements) {
  let text = readFileSync(WRANGLER_CONFIG, "utf8");
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  writeFileSync(WRANGLER_CONFIG, text);
}

const ghReady = () => attempt("gh", ["--version"]).ok && attempt("gh", ["auth", "status"]).ok;

async function setApiTokenSecret() {
  log("\nCreate a Cloudflare API token (Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit):");
  log("  https://dash.cloudflare.com/profile/api-tokens");
  const token =
    process.env.CLOUDFLARE_API_TOKEN || (await askHidden("Paste the API token (hidden):"));
  if (!token) return log("  no token entered — skipping (set the secret yourself later)");
  try {
    execFileSync("gh", ["secret", "set", "CLOUDFLARE_API_TOKEN"], {
      input: token,
      stdio: ["pipe", "inherit", "inherit"],
    });
    log("  set GitHub secret CLOUDFLARE_API_TOKEN");
  } catch {
    die("`gh secret set` failed — set CLOUDFLARE_API_TOKEN manually in repo settings");
  }
}

async function seedFirstAccount() {
  const name = await ask("Account name (e.g. your org id), blank to skip:");
  if (!name) return log("  skipped — create one later with `npm run admin -- create-account`");
  const pgp = await ask("Path to a PGP public key (.asc), blank to skip (required for releases):");
  const ns = await ask("Namespace (groupId prefix) to grant, e.g. net.example, blank to skip:");
  createAccount(name, pgp || undefined);
  if (ns) addNamespace(name, ns);
  const label = "ci";
  const token = addKey(name, label);
  printKey(name, label, token);
}

function recordTemplateRef(silent = false) {
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) return;
  git(["config", "--local", "merge.ours.driver", "true"]); // protect wrangler.jsonc on manual merges
  const ref =
    git(["rev-parse", "upstream/HEAD"]).out?.trim() ||
    git(["rev-parse", "upstream/main"]).out?.trim();
  if (!ref) return;
  git(["config", "--local", "template.syncRef", ref]);
  if (!silent) log(`  recorded template sync point ${ref.slice(0, 9)}`);
}

async function setup() {
  log("maven-worker setup\n");

  step("Selecting the Cloudflare account");
  const account = await chooseAccount();
  selectedAccountId = account.id;
  log(`  using ${account.name} (${account.id})`);

  step(`Ensuring R2 bucket '${BUCKET}'`);
  ensureBucket();

  step(`Ensuring D1 database '${DB}'`);
  const dbId = ensureDatabase();

  step("Writing ids into wrangler.jsonc");
  patchWranglerConfig([
    [DB_PLACEHOLDER, dbId],
    [ACCOUNT_PLACEHOLDER, account.id],
  ]);
  log(`  set database_id and account_id`);

  step("GitHub Actions secret");
  if (ghReady()) {
    if (await confirm("Set the CLOUDFLARE_API_TOKEN secret now via gh?", true))
      await setApiTokenSecret();
  } else {
    log("  gh not available/authed — add the CLOUDFLARE_API_TOKEN repo secret yourself.");
  }

  step("Database migrations");
  if (await confirm("Apply D1 migrations to the remote database now?", true)) {
    run("npx", ["wrangler", "d1", "migrations", "apply", DB, "--remote"], { env: env() });
  }

  step("First publishing account");
  if (await confirm("Create one now?", true)) await seedFirstAccount();

  step("Template updates");
  if (
    git(["rev-parse", "--is-inside-work-tree"]).ok &&
    !git(["remote", "get-url", "upstream"]).ok
  ) {
    const url = await ask(
      "Template repo URL for `npm run update` (blank to skip):",
      TEMPLATE_REPO_DEFAULT,
    );
    if (url) {
      git(["remote", "add", "upstream", url]);
      git(["fetch", "upstream"]);
    }
  }
  recordTemplateRef();

  step("Deploy");
  if (await confirm("Deploy the worker now?", false)) {
    run("npx", ["wrangler", "deploy"], { env: env() });
  }

  log("\n✓ Setup complete. Commit wrangler.jsonc and push to main — CI deploys the rest.");
}

// ── template update ───────────────────────────────────────────────────────────
function ensureUpstreamRemote() {
  if (git(["remote", "get-url", "upstream"]).ok) return true;
  return false;
}

async function update() {
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) die("not a git repository");
  git(["config", "--local", "merge.ours.driver", "true"]);

  if (!ensureUpstreamRemote()) {
    const url = await ask("Template repo URL (upstream):", TEMPLATE_REPO_DEFAULT);
    if (!url) die("no upstream URL provided");
    if (!git(["remote", "add", "upstream", url]).ok) die("failed to add upstream remote");
  }

  step("Fetching upstream");
  run("git", ["fetch", "upstream"]);
  const head = (
    git(["rev-parse", "upstream/HEAD"]).out || git(["rev-parse", "upstream/main"]).out
  ).trim();
  if (!head) die("could not resolve upstream/main");

  let base =
    flag("from") ||
    git(["config", "--local", "template.syncRef"]).out?.trim() ||
    git(["merge-base", "HEAD", head]).out?.trim();
  if (!base) {
    die(
      "no recorded sync point and histories are unrelated — re-run `npm run setup`, " +
        "or pass --from <the-commit-you-started-the-template-from>",
    );
  }
  if (base === head) {
    log("Already up to date with the template.");
    return;
  }

  const exclude = PROTECTED_PATHS.map((p) => `:(exclude)${p}`);
  const diffArgs = [`${base}..${head}`, "--", ".", ...exclude];
  const diff = git(["diff", ...diffArgs]).out;
  if (!diff.trim()) {
    log(`No applicable upstream changes (only ${PROTECTED_PATHS.join(", ")} differ).`);
    git(["config", "--local", "template.syncRef", head]);
    return;
  }

  log(`\nUpstream changes to apply (keeping ${PROTECTED_PATHS.join(", ")}):\n`);
  run("git", ["diff", "--stat", ...diffArgs]);

  if (!(await confirm("\nApply these to your working tree?", true))) return log("Aborted.");

  let clean = true;
  try {
    execFileSync("git", ["apply", "--3way", "--whitespace=nowarn"], {
      input: diff,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch {
    clean = false;
  }

  if (clean) {
    git(["config", "--local", "template.syncRef", head]);
    log("\n✓ Applied. Next: `npm install` (if deps changed), `npm run check`, then commit.");
  } else {
    log(
      "\n! Some hunks conflicted (look for <<<<<<< markers / .rej files). " +
        "Resolve them, run `npm run check`, commit, then run `npm run cli -- mark-synced`.",
    );
  }
}

function markSynced() {
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) die("not a git repository");
  git(["fetch", "upstream"]);
  recordTemplateRef(true);
  const ref = git(["config", "--local", "template.syncRef"]).out?.trim();
  log(ref ? `Recorded template sync point ${ref.slice(0, 9)}.` : "Could not record sync point.");
}

// ── dispatch ──────────────────────────────────────────────────────────────────
function warnIfUnconfigured() {
  try {
    if (readFileSync(WRANGLER_CONFIG, "utf8").includes(DB_PLACEHOLDER)) {
      log("note: wrangler.jsonc still has placeholder ids — run `npm run setup` first.\n");
    }
  } catch {
    /* ignore */
  }
}

try {
  switch (cmd) {
    case "setup":
      await setup();
      break;
    case "update":
      await update();
      break;
    case "mark-synced":
      markSynced();
      break;
    case "create-account": {
      const name = positionals[0] ?? die("create-account <name> [--pgp-key <file>]");
      warnIfUnconfigured();
      createAccount(name, flag("pgp-key"));
      break;
    }
    case "set-pgp-key": {
      const name = positionals[0] ?? die("set-pgp-key <name> <file>");
      const file = positionals[1] ?? die("set-pgp-key <name> <file>");
      setPgpKey(name, file);
      break;
    }
    case "add-namespace": {
      const name = positionals[0] ?? die("add-namespace <name> <prefix>");
      const prefix = positionals[1] ?? die("add-namespace <name> <prefix>");
      addNamespace(name, prefix);
      break;
    }
    case "add-key": {
      const name = positionals[0] ?? die("add-key <name> [--label <l>] [--expires <ISO>]");
      const label = flag("label") ?? "default";
      printKey(name, label, addKey(name, label, flag("expires")));
      break;
    }
    case "revoke-key": {
      const name = positionals[0] ?? die("revoke-key <name> <label>");
      const label = positionals[1] ?? die("revoke-key <name> <label>");
      revokeKey(name, label);
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
      die(`unknown command '${cmd ?? ""}'. See the header of scripts/cli.mjs for usage.`);
  }
} finally {
  closeRl();
}
