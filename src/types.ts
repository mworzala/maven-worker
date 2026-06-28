/** Whether a repository holds immutable, signature-gated releases or mutable snapshots. */
export type RepoKind = "release" | "snapshot";

/**
 * One entry in the route table. Maps a public `(host, prefix)` mount onto an internal
 * repository. Deployment paths are pure configuration — nothing here is hard-coded.
 *
 * - `host`: hostname to match, or `"*"` for any host.
 * - `prefix`: public path prefix to mount at, e.g. `/releases`, `/snapshots`, or `/`.
 * - `repo`: policy applied (immutable+signed releases vs mutable snapshots).
 * - `r2Prefix`: internal R2 key prefix the artifacts are stored under.
 */
export interface RepositoryConfig {
  host: string;
  prefix: string;
  repo: RepoKind;
  r2Prefix: string;
}

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  /** Injected by wrangler as a parsed array; tolerated as a JSON string too. */
  REPOSITORIES: RepositoryConfig[] | string;
}
