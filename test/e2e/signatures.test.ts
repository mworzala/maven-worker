import { createHash } from "node:crypto";
import { SELF, env } from "cloudflare:test";
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

const BASE = "https://repo.example.com";
const AUTH = basicAuth("minestom", "k");
const JAR = "releases/net/minestom/minestom/1.5.0/minestom-1.5.0.jar";

let privateKey: string;

function put(path: string, body: string, auth = AUTH): Promise<Response> {
  return SELF.fetch(`${BASE}/${path}`, { method: "PUT", headers: { Authorization: auth }, body });
}

beforeEach(async () => {
  await resetStorage();
  const keys = await generateKeypair("Minestom");
  privateKey = keys.privateKey;
  const id = await createAccount("minestom", { publicPgpKey: keys.publicKey });
  await addKey(id, "k");
  await addNamespace(id, "net.minestom");
});

describe("release signature verification", () => {
  it("publishes a release once a valid signature verifies it", async () => {
    expect((await put(JAR, "JARBYTES")).status).toBe(201);
    // Hidden before signing.
    expect((await SELF.fetch(`${BASE}/${JAR}`)).status).toBe(404);

    const sig = await signDetached(privateKey, "JARBYTES");
    expect((await put(`${JAR}.asc`, sig)).status).toBe(201);

    // Now downloadable, and listed in metadata.
    const get = await SELF.fetch(`${BASE}/${JAR}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("JARBYTES");
    expect((await SELF.fetch(`${BASE}/${JAR}.asc`)).status).toBe(200);

    const meta = await (
      await SELF.fetch(`${BASE}/releases/net/minestom/minestom/maven-metadata.xml`)
    ).text();
    expect(meta).toContain("<version>1.5.0</version>");
  });

  it("rejects a signature over different bytes and removes the artifact", async () => {
    await put(JAR, "JARBYTES");
    const sig = await signDetached(privateKey, "TAMPERED");
    expect((await put(`${JAR}.asc`, sig)).status).toBe(400);
    // The unverifiable artifact is deleted so it can never be served.
    expect(await env.BUCKET.get(JAR)).toBeNull();
    expect((await SELF.fetch(`${BASE}/${JAR}`)).status).toBe(404);
  });

  it("rejects a signature from a different key", async () => {
    await put(JAR, "JARBYTES");
    const other = await generateKeypair("Attacker");
    const sig = await signDetached(other.privateKey, "JARBYTES");
    expect((await put(`${JAR}.asc`, sig)).status).toBe(400);
  });

  it("rejects a signature uploaded before its artifact", async () => {
    const sig = await signDetached(privateKey, "JARBYTES");
    expect((await put(`${JAR}.asc`, sig)).status).toBe(400);
  });

  it("hides a release artifact's checksums until it is signed", async () => {
    await put(JAR, "data");
    expect((await SELF.fetch(`${BASE}/${JAR}.sha1`)).status).toBe(404);
    await put(`${JAR}.asc`, await signDetached(privateKey, "data"));
    const sha1 = await SELF.fetch(`${BASE}/${JAR}.sha1`);
    expect(sha1.status).toBe(200);
    expect(await sha1.text()).toBe(createHash("sha1").update("data").digest("hex"));
  });
});

describe("snapshots are not signature-gated", () => {
  const snap =
    "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT/minestom-1.6.0-20260101.000000-1.jar";

  it("serves snapshot artifacts immediately and stores signatures unverified", async () => {
    expect((await put(snap, "SNAP")).status).toBe(201);
    expect((await SELF.fetch(`${BASE}/${snap}`)).status).toBe(200);
    // Even a bogus signature is accepted for snapshots (not verified).
    expect((await put(`${snap}.asc`, "not a real signature")).status).toBe(201);
    expect((await SELF.fetch(`${BASE}/${snap}.asc`)).status).toBe(200);
  });
});
