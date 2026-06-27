import { describe, expect, it } from "vitest";
import {
  checksumTarget,
  classifyPath,
  isMetadataResource,
  parseFilename,
  type Resource,
} from "../../src/coordinates";

const REL = "net/minestom/minestom/1.5.0/minestom-1.5.0.jar";

describe("classifyPath: artifacts", () => {
  it("parses a plain release jar", () => {
    const r = classifyPath(REL);
    expect(r?.kind).toBe("artifact");
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord).toMatchObject({
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.5.0",
      versionInFile: "1.5.0",
      classifier: null,
      extension: "jar",
      filename: "minestom-1.5.0.jar",
    });
  });

  it("parses a classifier", () => {
    const r = classifyPath("net/minestom/minestom/1.5.0/minestom-1.5.0-sources.jar");
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord.classifier).toBe("sources");
    expect(r.coord.extension).toBe("jar");
  });

  it("parses a pom", () => {
    const r = classifyPath("net/minestom/minestom/1.5.0/minestom-1.5.0.pom");
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord.extension).toBe("pom");
  });

  it("parses a deep multi-segment groupId", () => {
    const r = classifyPath("a/b/c/d/lib/2.0/lib-2.0.jar");
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord.groupId).toBe("a.b.c.d");
    expect(r.coord.artifactId).toBe("lib");
  });

  it("parses a unique-snapshot timestamped jar", () => {
    const r = classifyPath(
      "net/minestom/minestom/1.6.0-SNAPSHOT/minestom-1.6.0-20260627.101500-3.jar",
    );
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord.version).toBe("1.6.0-SNAPSHOT");
    expect(r.coord.versionInFile).toBe("1.6.0-20260627.101500-3");
    expect(r.coord.classifier).toBeNull();
  });

  it("parses a unique-snapshot timestamped jar with classifier", () => {
    const r = classifyPath(
      "net/minestom/minestom/1.6.0-SNAPSHOT/minestom-1.6.0-20260627.101500-3-sources.jar",
    );
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord.versionInFile).toBe("1.6.0-20260627.101500-3");
    expect(r.coord.classifier).toBe("sources");
  });

  it("parses a non-unique snapshot jar", () => {
    const r = classifyPath("g/a/1.0-SNAPSHOT/a-1.0-SNAPSHOT.jar");
    if (r?.kind !== "artifact") throw new Error("bad");
    expect(r.coord.versionInFile).toBe("1.0-SNAPSHOT");
  });
});

describe("classifyPath: signatures and checksums", () => {
  it("detects an .asc signature", () => {
    const r = classifyPath(`${REL}.asc`);
    expect(r?.kind).toBe("signature");
    if (r?.kind !== "signature") throw new Error("bad");
    expect(r.coord.filename).toBe("minestom-1.5.0.jar");
  });

  it("detects checksums of an artifact", () => {
    for (const algo of ["md5", "sha1", "sha256", "sha512"] as const) {
      const r = classifyPath(`${REL}.${algo}`);
      expect(r?.kind).toBe("checksum");
      if (r?.kind !== "checksum") throw new Error("bad");
      expect(r.algo).toBe(algo);
      expect(r.target.kind).toBe("artifact");
    }
  });

  it("detects a checksum of a signature", () => {
    const r = classifyPath(`${REL}.asc.sha1`);
    if (r?.kind !== "checksum") throw new Error("bad");
    expect(r.target.kind).toBe("signature");
  });

  it("rejects a checksum of a checksum", () => {
    expect(classifyPath(`${REL}.sha1.md5`)).toBeNull();
  });
});

describe("classifyPath: metadata", () => {
  it("detects group-level metadata", () => {
    const r = classifyPath("net/minestom/minestom/maven-metadata.xml");
    expect(r).toEqual<Resource>({
      kind: "group-metadata",
      groupId: "net.minestom",
      artifactId: "minestom",
    });
  });

  it("detects snapshot version-level metadata", () => {
    const r = classifyPath("net/minestom/minestom/1.6.0-SNAPSHOT/maven-metadata.xml");
    expect(r).toEqual<Resource>({
      kind: "snapshot-metadata",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.6.0-SNAPSHOT",
    });
  });

  it("detects a checksum of group metadata", () => {
    const r = classifyPath("net/minestom/minestom/maven-metadata.xml.sha1");
    if (r?.kind !== "checksum") throw new Error("bad");
    expect(r.target.kind).toBe("group-metadata");
    expect(isMetadataResource(r)).toBe(true);
  });
});

describe("classifyPath: rejections", () => {
  it.each([
    "",
    "/",
    "..",
    "net/minestom/../secret",
    "net//minestom",
    "single-segment.jar",
    "g/a/1.0/wrongname-1.0.jar",
    "g/a/1.0/a-2.0.jar",
  ])("rejects %j", (p) => {
    expect(classifyPath(p)).toBeNull();
  });
});

describe("helpers", () => {
  it("parseFilename returns null for mismatched artifactId", () => {
    expect(parseFilename("other-1.0.jar", "lib", "1.0")).toBeNull();
  });

  it("checksumTarget unwraps", () => {
    const cs = classifyPath(`${REL}.sha1`)!;
    expect(checksumTarget(cs).kind).toBe("artifact");
    const art = classifyPath(REL)!;
    expect(checksumTarget(art)).toBe(art);
  });
});
