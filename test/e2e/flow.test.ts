import { createHash } from "node:crypto";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addKey,
  addNamespace,
  basicAuth,
  createAccount,
  generateKeypair,
  resetStorage,
  signDetached,
} from "../helpers";

const BASE = "https://maven.minestom.net";
const AUTH = basicAuth("minestom", "ci-key");
const hex = (algo: "md5" | "sha1", body: string): string =>
  createHash(algo).update(body).digest("hex");

let privateKey: string;

function put(path: string, body: string): Promise<Response> {
  return SELF.fetch(`${BASE}/${path}`, { method: "PUT", headers: { Authorization: AUTH }, body });
}
const get = (path: string): Promise<Response> => SELF.fetch(`${BASE}/${path}`);

/** Upload a primary artifact the way a Maven/Gradle client does: file, checksums, signature. */
async function deploySignedFile(path: string, body: string): Promise<void> {
  expect((await put(path, body)).status).toBe(201);
  expect((await put(`${path}.sha1`, hex("sha1", body))).status).toBe(200); // discarded
  expect((await put(`${path}.md5`, hex("md5", body))).status).toBe(200); // discarded
  expect((await put(`${path}.asc`, await signDetached(privateKey, body))).status).toBe(201);
}

beforeEach(async () => {
  await resetStorage();
  const keys = await generateKeypair("Minestom CI");
  privateKey = keys.privateKey;
  const id = await createAccount("minestom", { publicPgpKey: keys.publicKey });
  await addKey(id, "ci-key", { label: "ci" });
  await addNamespace(id, "net.minestom");
});

describe("end-to-end: signed release deploy and resolve", () => {
  const v = "releases/net/minestom/minestom/1.5.0";

  beforeEach(async () => {
    await deploySignedFile(`${v}/minestom-1.5.0.pom`, "<project>pom</project>");
    await deploySignedFile(`${v}/minestom-1.5.0.jar`, "the-jar-bytes");
    await deploySignedFile(`${v}/minestom-1.5.0-sources.jar`, "the-sources");
    // Client also uploads metadata, which we accept-and-discard in favour of our own.
    const metaPath = "releases/net/minestom/minestom/maven-metadata.xml";
    expect((await put(metaPath, "<client/>")).status).toBe(200);
  });

  it("resolves the group metadata listing the version", async () => {
    const meta = await get("releases/net/minestom/minestom/maven-metadata.xml");
    expect(meta.status).toBe(200);
    const xml = await meta.text();
    expect(xml).toContain("<version>1.5.0</version>");
    expect(xml).toContain("<release>1.5.0</release>");

    const sha1 = await get("releases/net/minestom/minestom/maven-metadata.xml.sha1");
    expect(await sha1.text()).toBe(createHash("sha1").update(xml).digest("hex"));
  });

  it("serves every signed artifact and matching checksums", async () => {
    for (const [file, body] of [
      ["minestom-1.5.0.jar", "the-jar-bytes"],
      ["minestom-1.5.0.pom", "<project>pom</project>"],
      ["minestom-1.5.0-sources.jar", "the-sources"],
    ] as const) {
      const res = await get(`${v}/${file}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
      expect(await (await get(`${v}/${file}.sha1`)).text()).toBe(hex("sha1", body));
      expect(await (await get(`${v}/${file}.md5`)).text()).toBe(hex("md5", body));
      expect((await get(`${v}/${file}.asc`)).status).toBe(200);
    }
  });

  it("exposes the version through the browse index", async () => {
    const html = await (await get("releases/net/minestom/minestom/")).text();
    expect(html).toContain("1.5.0/");
  });
});

describe("end-to-end: snapshot deploy and resolve", () => {
  const dir = "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT";
  const value = "1.6.0-20260627.101500-1";

  beforeEach(async () => {
    expect((await put(`${dir}/minestom-${value}.jar`, "snap-jar")).status).toBe(201);
    expect((await put(`${dir}/minestom-${value}.pom`, "snap-pom")).status).toBe(201);
  });

  it("maps -SNAPSHOT to the concrete build and resolves it", async () => {
    const meta = await (await get(`${dir}/maven-metadata.xml`)).text();
    expect(meta).toContain("<timestamp>20260627.101500</timestamp>");
    expect(meta).toContain(`<value>${value}</value>`);

    // A consumer reads the value, then fetches the concrete file.
    const jar = await get(`${dir}/minestom-${value}.jar`);
    expect(jar.status).toBe(200);
    expect(await jar.text()).toBe("snap-jar");
    expect(await (await get(`${dir}/minestom-${value}.jar.sha1`)).text()).toBe(
      hex("sha1", "snap-jar"),
    );
  });

  it("lists the snapshot version in the group metadata", async () => {
    const xml = await (await get("snapshots/net/minestom/minestom/maven-metadata.xml")).text();
    expect(xml).toContain("<version>1.6.0-SNAPSHOT</version>");
  });
});
