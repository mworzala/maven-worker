import type { Env } from "./types";
import { parseFilename } from "./coordinates";
import { type ArtifactRow, deleteArtifact, listAllSnapshotArtifacts } from "./db";

export const SNAPSHOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface GcResult {
  deleted: string[];
}

/**
 * Identify which build a file belongs to (the `yyyyMMdd.HHmmss-N` token), so all files of one
 * snapshot build are grouped together. Non-unique snapshots collapse to a single bucket.
 */
function buildIdentity(row: ArtifactRow): string {
  const versionInFile = parseFilename(row.filename, row.artifactId, row.version)?.versionInFile;
  return /(\d{8}\.\d{6}-\d+)$/.exec(versionInFile ?? "")?.[1] ?? "non-unique";
}

/**
 * Delete snapshot artifacts older than `maxAgeMs`, but always keep the newest build of each
 * `-SNAPSHOT` version so a referenced snapshot never fully disappears.
 */
export async function collectExpiredSnapshots(
  env: Env,
  now: number,
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
): Promise<GcResult> {
  const cutoff = now - maxAgeMs;
  const rows = await listAllSnapshotArtifacts(env.DB);

  const byVersion = new Map<string, ArtifactRow[]>();
  for (const r of rows) {
    const vk = `${r.groupId}:${r.artifactId}:${r.version}`;
    const list = byVersion.get(vk);
    if (list) list.push(r);
    else byVersion.set(vk, [r]);
  }

  const toDelete: ArtifactRow[] = [];
  for (const group of byVersion.values()) {
    // The newest build is whichever build the most recently deployed file belongs to.
    const newest = group.reduce((a, b) => (b.deployedAt > a.deployedAt ? b : a));
    const newestBuild = buildIdentity(newest);
    for (const r of group) {
      if (buildIdentity(r) === newestBuild) continue;
      if (r.deployedAt < cutoff) toDelete.push(r);
    }
  }

  for (const r of toDelete) {
    await env.BUCKET.delete([r.key, `${r.key}.asc`]);
    await deleteArtifact(env.DB, r.key);
  }
  return { deleted: toDelete.map((r) => r.key) };
}

export function runSnapshotGc(env: Env, now: number): Promise<GcResult> {
  return collectExpiredSnapshots(env, now);
}
