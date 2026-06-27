import { createHash } from "node:crypto";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccount, resetStorage, seedArtifact } from "../helpers";

const BASE = "https://repo.example.com";
const text = (res: Response): Promise<string> => res.text();

beforeEach(async () => {
  await resetStorage();
  await createAccount("seed");
});

describe("group metadata generation", () => {
  beforeEach(async () => {
    await seedArtifact({
      key: "releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar",
      repo: "release",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.0.0",
      filename: "minestom-1.0.0.jar",
      deployedAt: 1000,
    });
    await seedArtifact({
      key: "releases/net/minestom/minestom/1.1.0/minestom-1.1.0.jar",
      repo: "release",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.1.0",
      filename: "minestom-1.1.0.jar",
      deployedAt: 2000,
    });
  });

  it("lists versions with latest and release", async () => {
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
    const xml = await text(res);
    expect(xml).toContain("<version>1.0.0</version>");
    expect(xml).toContain("<version>1.1.0</version>");
    expect(xml).toContain("<latest>1.1.0</latest>");
    expect(xml).toContain("<release>1.1.0</release>");
  });

  it("omits unverified (pending) artifacts", async () => {
    await seedArtifact({
      key: "releases/net/minestom/minestom/2.0.0/minestom-2.0.0.jar",
      repo: "release",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "2.0.0",
      filename: "minestom-2.0.0.jar",
      verified: 0,
      deployedAt: 3000,
    });
    const xml = await text(
      await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`),
    );
    expect(xml).not.toContain("<version>2.0.0</version>");
    expect(xml).toContain("<latest>1.1.0</latest>");
  });

  it("404s when the artifact has no versions", async () => {
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/ghost/maven-metadata.xml`);
    expect(res.status).toBe(404);
  });

  it("supports conditional requests with ETag", async () => {
    const first = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`);
    const etag = first.headers.get("ETag")!;
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
  });
});

describe("checksum generation", () => {
  it("generates all four checksums of an artifact", async () => {
    await seedArtifact({
      key: "releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar",
      repo: "release",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.0.0",
      filename: "minestom-1.0.0.jar",
      body: "hello world",
    });
    for (const algo of ["md5", "sha1", "sha256", "sha512"] as const) {
      const res = await SELF.fetch(
        `${BASE}/releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar.${algo}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain;charset=utf-8");
      expect(await text(res)).toBe(createHash(algo).update("hello world").digest("hex"));
    }
  });

  it("404s for a checksum of a missing artifact", async () => {
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/x/1.0/x-1.0.jar.sha1`);
    expect(res.status).toBe(404);
  });

  it("generates a checksum consistent with the metadata it shadows", async () => {
    await seedArtifact({
      key: "releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar",
      repo: "release",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.0.0",
      filename: "minestom-1.0.0.jar",
    });
    const meta = await text(
      await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`),
    );
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml.sha1`);
    expect(await text(res)).toBe(createHash("sha1").update(meta).digest("hex"));
  });
});

describe("snapshot metadata generation", () => {
  const base = {
    repo: "snapshot" as const,
    groupId: "net.minestom",
    artifactId: "minestom",
    version: "1.6.0-SNAPSHOT",
  };
  const dir = "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT";

  it("maps -SNAPSHOT to the newest timestamped build", async () => {
    await seedArtifact({
      ...base,
      key: `${dir}/minestom-1.6.0-20260627.101500-1.jar`,
      filename: "minestom-1.6.0-20260627.101500-1.jar",
      deployedAt: 1000,
    });
    await seedArtifact({
      ...base,
      key: `${dir}/minestom-1.6.0-20260627.101500-1-sources.jar`,
      filename: "minestom-1.6.0-20260627.101500-1-sources.jar",
      classifier: "sources",
      deployedAt: 1000,
    });
    await seedArtifact({
      ...base,
      key: `${dir}/minestom-1.6.0-20260628.090000-2.jar`,
      filename: "minestom-1.6.0-20260628.090000-2.jar",
      deployedAt: 2000,
    });

    const xml = await text(await SELF.fetch(`${BASE}/${dir}/maven-metadata.xml`));
    expect(xml).toContain("<version>1.6.0-SNAPSHOT</version>");
    expect(xml).toContain("<timestamp>20260628.090000</timestamp>");
    expect(xml).toContain("<buildNumber>2</buildNumber>");
    expect(xml).toContain("<value>1.6.0-20260628.090000-2</value>");
    expect(xml).toContain("<classifier>sources</classifier>");
  });

  it("lists the -SNAPSHOT version in the group metadata without a release", async () => {
    await seedArtifact({
      ...base,
      key: `${dir}/minestom-1.6.0-20260627.101500-1.jar`,
      filename: "minestom-1.6.0-20260627.101500-1.jar",
    });
    const xml = await text(
      await SELF.fetch(`${BASE}/snapshots/net/minestom/minestom/maven-metadata.xml`),
    );
    expect(xml).toContain("<version>1.6.0-SNAPSHOT</version>");
    expect(xml).toContain("<latest>1.6.0-SNAPSHOT</latest>");
    expect(xml).not.toContain("<release>");
  });
});
