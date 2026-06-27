import { createHash } from "node:crypto";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addKey, addNamespace, basicAuth, createAccount, resetStorage } from "../helpers";

const BASE = "https://repo.example.com";
const AUTH = basicAuth("minestom", "k");

function put(path: string, body: string): Promise<Response> {
  return SELF.fetch(`${BASE}/${path}`, {
    method: "PUT",
    headers: { Authorization: AUTH },
    body,
  });
}

const text = (res: Response): Promise<string> => res.text();

beforeEach(async () => {
  await resetStorage();
  const id = await createAccount("minestom");
  await addKey(id, "k");
  await addNamespace(id, "net.minestom");
});

describe("group metadata generation", () => {
  beforeEach(async () => {
    await put("releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar", "a");
    await put("releases/net/minestom/minestom/1.1.0/minestom-1.1.0.jar", "b");
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
    await put("releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar", "hello world");
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
    await put("releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar", "a");
    const meta = await text(
      await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`),
    );
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml.sha1`);
    expect(await text(res)).toBe(createHash("sha1").update(meta).digest("hex"));
  });
});

describe("snapshot metadata generation", () => {
  const dir = "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT";

  it("maps -SNAPSHOT to the newest timestamped build", async () => {
    await put(`${dir}/minestom-1.6.0-20260627.101500-1.jar`, "j1");
    await put(`${dir}/minestom-1.6.0-20260627.101500-1-sources.jar`, "s1");
    await put(`${dir}/minestom-1.6.0-20260628.090000-2.jar`, "j2");

    const xml = await text(await SELF.fetch(`${BASE}/${dir}/maven-metadata.xml`));
    expect(xml).toContain("<version>1.6.0-SNAPSHOT</version>");
    expect(xml).toContain("<timestamp>20260628.090000</timestamp>");
    expect(xml).toContain("<buildNumber>2</buildNumber>");
    expect(xml).toContain("<value>1.6.0-20260628.090000-2</value>");
    // The sources classifier from the earlier build is still represented.
    expect(xml).toContain("<classifier>sources</classifier>");
  });

  it("lists the -SNAPSHOT version in the group metadata", async () => {
    await put(`${dir}/minestom-1.6.0-20260627.101500-1.jar`, "j1");
    const xml = await text(
      await SELF.fetch(`${BASE}/snapshots/net/minestom/minestom/maven-metadata.xml`),
    );
    expect(xml).toContain("<version>1.6.0-SNAPSHOT</version>");
    expect(xml).toContain("<latest>1.6.0-SNAPSHOT</latest>");
    // No releases in a snapshot repo.
    expect(xml).not.toContain("<release>");
  });
});
