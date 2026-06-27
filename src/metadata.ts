import type { Env, RepoKind } from "./types";
import { type MetadataResource, parseFilename } from "./coordinates";
import { listSnapshotArtifacts, listVersions } from "./db";
import { cacheControlFor, generatedResponse, notFound } from "./http";
import type { ResolvedRepo } from "./config";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

interface Parts {
  y: number;
  mo: string;
  d: string;
  h: string;
  mi: string;
  s: string;
}

function utcParts(ms: number): Parts {
  const date = new Date(ms);
  return {
    y: date.getUTCFullYear(),
    mo: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    h: pad(date.getUTCHours()),
    mi: pad(date.getUTCMinutes()),
    s: pad(date.getUTCSeconds()),
  };
}

/** `lastUpdated`/`updated` format: `yyyyMMddHHmmss`. */
function fmtCompact(ms: number): string {
  const p = utcParts(ms);
  return `${p.y}${p.mo}${p.d}${p.h}${p.mi}${p.s}`;
}

/** Snapshot `<timestamp>` format: `yyyyMMdd.HHmmss`. */
function fmtSnapshotTimestamp(ms: number): string {
  const p = utcParts(ms);
  return `${p.y}${p.mo}${p.d}.${p.h}${p.mi}${p.s}`;
}

/** Group/artifact-level metadata: the list of available versions. */
export async function generateGroupMetadata(
  db: D1Database,
  repo: RepoKind,
  groupId: string,
  artifactId: string,
): Promise<string | null> {
  const versions = await listVersions(db, repo, groupId, artifactId);
  if (versions.length === 0) return null;

  const latest = versions[versions.length - 1]!.version;
  const releases = versions.filter((v) => !v.version.endsWith("-SNAPSHOT"));
  const release = releases.length > 0 ? releases[releases.length - 1]!.version : null;
  const lastUpdated = fmtCompact(Math.max(...versions.map((v) => v.updated)));

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<metadata>",
    `  <groupId>${escapeXml(groupId)}</groupId>`,
    `  <artifactId>${escapeXml(artifactId)}</artifactId>`,
    "  <versioning>",
    `    <latest>${escapeXml(latest)}</latest>`,
    ...(release === null ? [] : [`    <release>${escapeXml(release)}</release>`]),
    "    <versions>",
    ...versions.map((v) => `      <version>${escapeXml(v.version)}</version>`),
    "    </versions>",
    `    <lastUpdated>${lastUpdated}</lastUpdated>`,
    "  </versioning>",
    "</metadata>",
    "",
  ];
  return lines.join("\n");
}

/** Snapshot version-level metadata: maps `-SNAPSHOT` to concrete timestamped builds. */
export async function generateSnapshotMetadata(
  db: D1Database,
  repo: RepoKind,
  groupId: string,
  artifactId: string,
  version: string,
): Promise<string | null> {
  const rows = await listSnapshotArtifacts(db, repo, groupId, artifactId, version);
  if (rows.length === 0) return null;

  const parsed = rows.map((r) => {
    const versionInFile = parseFilename(r.filename, artifactId, version)?.versionInFile ?? version;
    const m = /-(\d{8}\.\d{6})-(\d+)$/.exec(versionInFile);
    return {
      ...r,
      versionInFile,
      timestamp: m?.[1] ?? null,
      buildNumber: m ? Number.parseInt(m[2]!, 10) : 0,
    };
  });

  const latest = parsed.reduce((a, b) => (b.deployedAt > a.deployedAt ? b : a));
  const lastUpdated = Math.max(...parsed.map((p) => p.deployedAt));

  // Latest concrete value per (classifier, extension).
  const byKey = new Map<string, (typeof parsed)[number]>();
  for (const p of parsed) {
    const k = `${p.classifier ?? ""}:${p.extension}`;
    const cur = byKey.get(k);
    if (!cur || p.deployedAt > cur.deployedAt) byKey.set(k, p);
  }

  const snapshotVersions = [...byKey.values()].flatMap((p) => [
    "      <snapshotVersion>",
    ...(p.classifier === null
      ? []
      : [`        <classifier>${escapeXml(p.classifier)}</classifier>`]),
    `        <extension>${escapeXml(p.extension)}</extension>`,
    `        <value>${escapeXml(p.versionInFile)}</value>`,
    `        <updated>${fmtCompact(p.deployedAt)}</updated>`,
    "      </snapshotVersion>",
  ]);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<metadata>",
    `  <groupId>${escapeXml(groupId)}</groupId>`,
    `  <artifactId>${escapeXml(artifactId)}</artifactId>`,
    `  <version>${escapeXml(version)}</version>`,
    "  <versioning>",
    "    <snapshot>",
    `      <timestamp>${latest.timestamp ?? fmtSnapshotTimestamp(latest.deployedAt)}</timestamp>`,
    `      <buildNumber>${latest.buildNumber}</buildNumber>`,
    "    </snapshot>",
    `    <lastUpdated>${fmtCompact(lastUpdated)}</lastUpdated>`,
    "    <snapshotVersions>",
    ...snapshotVersions,
    "    </snapshotVersions>",
    "  </versioning>",
    "</metadata>",
    "",
  ];
  return lines.join("\n");
}

/** Generate the XML for whichever metadata resource was requested. */
export function generateMetadataXml(
  env: Env,
  repo: RepoKind,
  resource: MetadataResource,
): Promise<string | null> {
  return resource.kind === "snapshot-metadata"
    ? generateSnapshotMetadata(
        env.DB,
        repo,
        resource.groupId,
        resource.artifactId,
        resource.version,
      )
    : generateGroupMetadata(env.DB, repo, resource.groupId, resource.artifactId);
}

/** Serve a generated metadata document. */
export async function handleMetadata(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
  resource: MetadataResource,
): Promise<Response> {
  const xml = await generateMetadataXml(env, resolved.repo, resource);
  if (xml === null) return notFound();
  return generatedResponse(
    request,
    xml,
    "application/xml",
    cacheControlFor(resolved.repo, resource),
  );
}
