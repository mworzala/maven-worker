import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const BASE = "https://repo.example.com";
const JAR_KEY = "releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar";
const JAR_BODY = "PK fake jar bytes ABCDEFG";

async function seed(key: string, body: string): Promise<void> {
  await env.BUCKET.put(key, body);
}

describe("read path (GET/HEAD)", () => {
  beforeEach(async () => {
    await seed(JAR_KEY, JAR_BODY);
  });

  it("serves a release jar with correct headers", async () => {
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/java-archive");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(await res.text()).toBe(JAR_BODY);
  });

  it("HEAD returns metadata without a body", async () => {
    const res = await SELF.fetch(
      `${BASE}/releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`,
      {
        method: "HEAD",
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(JAR_BODY.length));
    expect(await res.text()).toBe("");
  });

  it("returns 404 for a missing object", async () => {
    const res = await SELF.fetch(`${BASE}/releases/net/minestom/minestom/9.9.9/minestom-9.9.9.jar`);
    expect(res.status).toBe(404);
  });

  it("honors If-None-Match with 304", async () => {
    const first = await SELF.fetch(
      `${BASE}/releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`,
    );
    const etag = first.headers.get("ETag")!;
    const res = await SELF.fetch(
      `${BASE}/releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`,
      {
        headers: { "If-None-Match": etag },
      },
    );
    expect(res.status).toBe(304);
  });

  it("serves a byte range with 206", async () => {
    const res = await SELF.fetch(
      `${BASE}/releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar`,
      {
        headers: { Range: "bytes=0-3" },
      },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${JAR_BODY.length}`);
    expect(await res.text()).toBe(JAR_BODY.slice(0, 4));
  });

  it("uses the right content types", async () => {
    await seed("releases/g/a/1.0/a-1.0.pom", "<project/>");
    await seed("releases/g/a/1.0/a-1.0.jar.sha1", "abc123");
    await seed("releases/g/a/maven-metadata.xml", "<metadata/>");

    const pom = await SELF.fetch(`${BASE}/releases/g/a/1.0/a-1.0.pom`);
    expect(pom.headers.get("Content-Type")).toBe("application/xml");
    const sha = await SELF.fetch(`${BASE}/releases/g/a/1.0/a-1.0.jar.sha1`);
    expect(sha.headers.get("Content-Type")).toBe("text/plain;charset=utf-8");
    const meta = await SELF.fetch(`${BASE}/releases/g/a/maven-metadata.xml`);
    expect(meta.headers.get("Content-Type")).toBe("application/xml");
    expect(meta.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
  });

  it("marks snapshot artifacts as short-lived", async () => {
    await env.BUCKET.put("snapshots/g/a/1.0-SNAPSHOT/a-1.0-20260101.000000-1.jar", "x");
    const res = await SELF.fetch(`${BASE}/snapshots/g/a/1.0-SNAPSHOT/a-1.0-20260101.000000-1.jar`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
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

describe("browse index", () => {
  it("lists a directory", async () => {
    await seed("releases/g/a/1.0/a-1.0.jar", "x");
    await seed("releases/g/a/1.0/a-1.0.pom", "x");
    await seed("releases/g/a/2.0/a-2.0.jar", "x");

    const res = await SELF.fetch(`${BASE}/releases/g/a/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html;charset=utf-8");
    const html = await res.text();
    expect(html).toContain("1.0/");
    expect(html).toContain("2.0/");
    expect(html).toContain("../");
  });

  it("lists files within a version directory", async () => {
    await seed("releases/g/a/1.0/a-1.0.jar", "x");
    await seed("releases/g/a/1.0/a-1.0.pom", "x");
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
