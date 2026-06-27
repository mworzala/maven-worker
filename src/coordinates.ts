/**
 * Parsing of Maven repository paths into typed resources.
 *
 * A Maven path is purely structural:
 *   <groupId with '.'→'/'>/<artifactId>/<version>/<artifactId>-<version>[-<classifier>].<ext>
 * plus `maven-metadata.xml` files at the group/artifact and (snapshot) version levels, and
 * `.asc` signatures / `.md5|.sha1|.sha256|.sha512` checksums shadowing any of the above.
 */

export type ChecksumAlgo = "md5" | "sha1" | "sha256" | "sha512";
export const CHECKSUM_ALGOS: readonly ChecksumAlgo[] = ["md5", "sha1", "sha256", "sha512"];

export const METADATA_FILENAME = "maven-metadata.xml";

export interface Coordinate {
  groupId: string;
  artifactId: string;
  /** Directory version, e.g. `1.5.0` or `1.6.0-SNAPSHOT`. */
  version: string;
  /** Version token embedded in the filename; timestamped for unique snapshots. */
  versionInFile: string;
  classifier: string | null;
  extension: string;
  filename: string;
}

export type Resource =
  | { kind: "artifact"; coord: Coordinate }
  | { kind: "signature"; coord: Coordinate }
  | { kind: "group-metadata"; groupId: string; artifactId: string }
  | { kind: "snapshot-metadata"; groupId: string; artifactId: string; version: string }
  | { kind: "checksum"; algo: ChecksumAlgo; target: Resource };

export type MetadataResource = Extract<
  Resource,
  { kind: "group-metadata" } | { kind: "snapshot-metadata" }
>;

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last path segment. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function splitExtension(name: string): { stem: string; ext: string } | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

interface FilenameParts {
  versionInFile: string;
  classifier: string | null;
  extension: string;
}

/**
 * Split `<artifactId>-<version>[-<classifier>].<ext>` knowing the directory version. Handles
 * release versions, unique snapshots (`base-yyyyMMdd.HHmmss-N`) and non-unique snapshots.
 */
export function parseFilename(
  filename: string,
  artifactId: string,
  dirVersion: string,
): FilenameParts | null {
  const prefix = `${artifactId}-`;
  if (!filename.startsWith(prefix)) return null;
  const split = splitExtension(filename);
  if (!split) return null;
  const { ext } = split;
  const coordPart = split.stem.slice(prefix.length);
  if (coordPart === "") return null;

  const literal = (version: string): FilenameParts | null => {
    if (coordPart === version) return { versionInFile: version, classifier: null, extension: ext };
    if (coordPart.startsWith(`${version}-`)) {
      return {
        versionInFile: version,
        classifier: coordPart.slice(version.length + 1),
        extension: ext,
      };
    }
    return null;
  };

  if (dirVersion.endsWith("-SNAPSHOT")) {
    const base = dirVersion.slice(0, -"-SNAPSHOT".length);
    const unique = new RegExp(`^(${escapeRegExp(base)}-\\d{8}\\.\\d{6}-\\d+)(?:-(.+))?$`).exec(
      coordPart,
    );
    if (unique) {
      return { versionInFile: unique[1]!, classifier: unique[2] ?? null, extension: ext };
    }
    return literal(dirVersion);
  }
  return literal(dirVersion);
}

/** Classify a repository-relative path (no leading slash, no mount prefix). */
export function classifyPath(path: string): Resource | null {
  const clean = path.replace(/^\/+/, "");
  if (clean === "") return null;
  const segments = clean.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;

  for (const algo of CHECKSUM_ALGOS) {
    if (clean.endsWith(`.${algo}`)) {
      const target = classifyPath(clean.slice(0, -(algo.length + 1)));
      if (!target || target.kind === "checksum") return null;
      return { kind: "checksum", algo, target };
    }
  }

  const filename = segments[segments.length - 1]!;

  if (filename.endsWith(".asc")) {
    const inner = classifyPath(clean.slice(0, -4));
    if (!inner || inner.kind !== "artifact") return null;
    return { kind: "signature", coord: inner.coord };
  }

  if (filename === METADATA_FILENAME) {
    const dirs = segments.slice(0, -1);
    if (dirs.length < 2) return null;
    const last = dirs[dirs.length - 1]!;
    if (last.endsWith("-SNAPSHOT")) {
      if (dirs.length < 3) return null;
      return {
        kind: "snapshot-metadata",
        groupId: dirs.slice(0, -2).join("."),
        artifactId: dirs[dirs.length - 2]!,
        version: last,
      };
    }
    return { kind: "group-metadata", groupId: dirs.slice(0, -1).join("."), artifactId: last };
  }

  if (segments.length < 4) return null;
  const version = segments[segments.length - 2]!;
  const artifactId = segments[segments.length - 3]!;
  const groupId = segments.slice(0, segments.length - 3).join(".");
  const parts = parseFilename(filename, artifactId, version);
  if (!parts) return null;
  return {
    kind: "artifact",
    coord: {
      groupId,
      artifactId,
      version,
      versionInFile: parts.versionInFile,
      classifier: parts.classifier,
      extension: parts.extension,
      filename,
    },
  };
}

/** The underlying resource a checksum targets, or the resource itself. */
export function checksumTarget(resource: Resource): Resource {
  return resource.kind === "checksum" ? resource.target : resource;
}

/** True if a resource is (or shadows) a generated metadata document. */
export function isMetadataResource(resource: Resource): boolean {
  const target = checksumTarget(resource);
  return target.kind === "group-metadata" || target.kind === "snapshot-metadata";
}

/** The groupId a resource (or its checksum target) belongs to. */
export function resourceGroupId(resource: Resource): string {
  switch (resource.kind) {
    case "artifact":
    case "signature":
      return resource.coord.groupId;
    case "group-metadata":
    case "snapshot-metadata":
      return resource.groupId;
    case "checksum":
      return resourceGroupId(resource.target);
  }
}

/** The directory version a resource targets, or null for group-level metadata. */
export function resourceVersion(resource: Resource): string | null {
  switch (resource.kind) {
    case "artifact":
    case "signature":
      return resource.coord.version;
    case "snapshot-metadata":
      return resource.version;
    case "group-metadata":
      return null;
    case "checksum":
      return resourceVersion(resource.target);
  }
}
