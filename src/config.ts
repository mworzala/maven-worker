import type { Env, RepoKind, RepositoryConfig } from "./types";

export interface ResolvedRepo {
  repo: RepoKind;
  r2Prefix: string;
  /** Request path with the mount prefix stripped (no leading slash). */
  relPath: string;
}

/** Read and validate the route table from configuration. */
export function loadRepositories(env: Env): RepositoryConfig[] {
  const raw: unknown =
    typeof env.REPOSITORIES === "string" ? JSON.parse(env.REPOSITORIES) : env.REPOSITORIES;
  if (!Array.isArray(raw)) throw new Error("REPOSITORIES must be an array");
  for (const entry of raw) {
    if (
      typeof entry?.host !== "string" ||
      typeof entry?.prefix !== "string" ||
      (entry?.repo !== "release" && entry?.repo !== "snapshot") ||
      typeof entry?.r2Prefix !== "string"
    ) {
      throw new Error(`invalid repository config entry: ${JSON.stringify(entry)}`);
    }
  }
  return raw as RepositoryConfig[];
}

function stripPrefix(pathname: string, prefix: string): string | null {
  let p = prefix;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "" || p === "/") return pathname.replace(/^\/+/, "");
  if (pathname === p) return "";
  if (pathname.startsWith(`${p}/`)) return pathname.slice(p.length + 1);
  return null;
}

/**
 * Resolve which repository a request maps to. Exact host beats `"*"`; among equally specific
 * hosts the longest matching path prefix wins.
 */
export function resolveRepo(
  repos: RepositoryConfig[],
  host: string,
  pathname: string,
): ResolvedRepo | null {
  let best: {
    hostScore: number;
    prefixLen: number;
    cfg: RepositoryConfig;
    relPath: string;
  } | null = null;
  for (const cfg of repos) {
    let hostScore: number;
    if (cfg.host === "*") hostScore = 0;
    else if (cfg.host.toLowerCase() === host.toLowerCase()) hostScore = 1;
    else continue;

    const relPath = stripPrefix(pathname, cfg.prefix);
    if (relPath === null) continue;

    const prefixLen = cfg.prefix.replace(/\/+$/, "").length;
    if (
      best === null ||
      hostScore > best.hostScore ||
      (hostScore === best.hostScore && prefixLen > best.prefixLen)
    ) {
      best = { hostScore, prefixLen, cfg, relPath };
    }
  }
  if (best === null) return null;
  return { repo: best.cfg.repo, r2Prefix: best.cfg.r2Prefix, relPath: best.relPath };
}

/** Build the R2 object key for a repository-relative path. */
export function r2Key(resolved: ResolvedRepo, relPath = resolved.relPath): string {
  return `${resolved.r2Prefix}/${relPath}`;
}
