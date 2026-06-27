import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccount, resetStorage, seedArtifact } from "../helpers";

const BASE = "https://repo.example.com";
// Snapshots are not signature-gated, so they exercise raw object serving directly.
const SNAP_DIR = "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT";
const JAR_KEY = `${SNAP_DIR}/minestom-1.6.0-20260101.000000-1.jar`;
const JAR_URL = `${BASE}/${JAR_KEY}`;
const JAR_BODY = "PK fake jar bytes ABCDEFG";

beforeEach(resetStorage);

describe("read path (GET/HEAD)", () => {
  beforeEach(async () => {
    await env.BUCKET.put(JAR_KEY, JAR_BODY);
  });

  it("serves an artifact with correct headers", async () => {
    const res = await SELF.fetch(JAR_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/java-archive");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(await res.text()).toBe(JAR_BODY);
  });

  it("HEAD returns metadata without a body", async () => {
    const res = await SELF.fetch(JAR_URL, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(JAR_BODY.length));
    expect(await res.text()).toBe("");
  });

  it("returns 404 for a missing object", async () => {
    const res = await SELF.fetch(`${BASE}/${SNAP_DIR}/minestom-1.6.0-20260101.000000-9.jar`);
    expect(res.status).toBe(404);
  });

  it("honors If-None-Match with 304", async () => {
    const etag = (await SELF.fetch(JAR_URL)).headers.get("ETag")!;
    const res = await SELF.fetch(JAR_URL, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
  });

  it("serves a byte range with 206", async () => {
    const res = await SELF.fetch(JAR_URL, { headers: { Range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${JAR_BODY.length}`);
    expect(await res.text()).toBe(JAR_BODY.slice(0, 4));
  });

  it("uses the right content types for stored objects", async () => {
    await env.BUCKET.put(`${SNAP_DIR}/minestom-1.6.0-20260101.000000-1.pom`, "<project/>");
    await env.BUCKET.put(`${JAR_KEY}.asc`, "SIGNATURE");

    const pom = await SELF.fetch(`${BASE}/${SNAP_DIR}/minestom-1.6.0-20260101.000000-1.pom`);
    expect(pom.headers.get("Content-Type")).toBe("application/xml");
    const asc = await SELF.fetch(`${JAR_URL}.asc`);
    expect(asc.headers.get("Content-Type")).toBe("application/pgp-signature");
  });

  it("returns 405 for unsupported methods", async () => {
    const res = await SELF.fetch(`${BASE}/releases/x`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("GET");
  });

  it("returns 404 for an unmapped host/path", async () => {
    const res = await SELF.fetch(`${BASE}/not-a-repo/x`);
    expect(res.status).toBe(404);
  });
});

describe("release gating and caching", () => {
  beforeEach(async () => {
    await createAccount("seed");
  });

  it("serves a verified release artifact with immutable caching", async () => {
    await seedArtifact({
      key: "releases/g/a/1.0/a-1.0.jar",
      repo: "release",
      groupId: "g",
      artifactId: "a",
      version: "1.0",
      filename: "a-1.0.jar",
      verified: 1,
      body: "RELEASE",
    });
    const res = await SELF.fetch(`${BASE}/releases/g/a/1.0/a-1.0.jar`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("RELEASE");
  });

  it("hides a pending (unverified) release artifact", async () => {
    await seedArtifact({
      key: "releases/g/a/2.0/a-2.0.jar",
      repo: "release",
      groupId: "g",
      artifactId: "a",
      version: "2.0",
      filename: "a-2.0.jar",
      verified: 0,
      body: "PENDING",
    });
    expect((await SELF.fetch(`${BASE}/releases/g/a/2.0/a-2.0.jar`)).status).toBe(404);
  });
});

describe("browse index", () => {
  it("lists a directory", async () => {
    await env.BUCKET.put("releases/g/a/1.0/a-1.0.jar", "x");
    await env.BUCKET.put("releases/g/a/1.0/a-1.0.pom", "x");
    await env.BUCKET.put("releases/g/a/2.0/a-2.0.jar", "x");

    const res = await SELF.fetch(`${BASE}/releases/g/a/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html;charset=utf-8");
    const html = await res.text();
    expect(html).toContain("1.0/");
    expect(html).toContain("2.0/");
    expect(html).toContain("../");
  });

  it("lists files within a version directory", async () => {
    await env.BUCKET.put("releases/g/a/1.0/a-1.0.jar", "x");
    await env.BUCKET.put("releases/g/a/1.0/a-1.0.pom", "x");
    const res = await SELF.fetch(`${BASE}/releases/g/a/1.0/`);
    const html = await res.text();
    expect(html).toContain("a-1.0.jar");
    expect(html).toContain("a-1.0.pom");
  });

  it("404s for an empty directory", async () => {
    const res = await SELF.fetch(`${BASE}/releases/nope/`);
    expect(res.status).toBe(404);
  });
});
