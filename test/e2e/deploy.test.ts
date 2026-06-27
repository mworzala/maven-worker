import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth";
import { addKey, addNamespace, basicAuth, createAccount, resetStorage } from "../helpers";

const BASE = "https://repo.example.com";
const KEY = "deploy-key-secret-123";
const AUTH = basicAuth("minestom", KEY);
const REL = "net/minestom/minestom/1.5.0/minestom-1.5.0.jar";

function put(path: string, body: string, auth: string | null = AUTH): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.Authorization = auth;
  return SELF.fetch(`${BASE}/${path}`, { method: "PUT", headers, body });
}

beforeEach(async () => {
  await resetStorage();
  const id = await createAccount("minestom");
  await addKey(id, KEY);
  await addNamespace(id, "net.minestom");
});

describe("deploy: authentication", () => {
  it("rejects an unauthenticated PUT with 401", async () => {
    const res = await put(`releases/${REL}`, "x", null);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("rejects a wrong key with 401", async () => {
    const res = await put(`releases/${REL}`, "x", basicAuth("minestom", "wrong"));
    expect(res.status).toBe(401);
  });

  it("rejects an unknown account with 401", async () => {
    const res = await put(`releases/${REL}`, "x", basicAuth("ghost", KEY));
    expect(res.status).toBe(401);
  });

  it("rejects an expired key", async () => {
    const id = await createAccount("expired");
    await addKey(id, "ek", { expiresAt: Date.now() - 1000 });
    await addNamespace(id, "com.expired");
    const res = await put("releases/com/expired/a/1.0/a-1.0.jar", "x", basicAuth("expired", "ek"));
    expect(res.status).toBe(401);
  });
});

describe("deploy: authorization", () => {
  it("accepts a deploy to an owned namespace", async () => {
    const res = await put(`releases/${REL}`, "JARBYTES");
    expect(res.status).toBe(201);
    const get = await SELF.fetch(`${BASE}/releases/${REL}`);
    expect(await get.text()).toBe("JARBYTES");
  });

  it("accepts a deploy to a sub-namespace", async () => {
    const res = await put("releases/net/minestom/server/lib/1.0/lib-1.0.jar", "x");
    expect(res.status).toBe(201);
  });

  it("rejects a deploy to an unowned namespace with 403", async () => {
    const res = await put("releases/com/evil/lib/1.0/lib-1.0.jar", "x");
    expect(res.status).toBe(403);
  });
});

describe("deploy: repository/version agreement", () => {
  it("rejects a snapshot version in the releases repo", async () => {
    const res = await put("releases/net/minestom/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.jar", "x");
    expect(res.status).toBe(400);
  });

  it("rejects a release version in the snapshots repo", async () => {
    const res = await put("snapshots/net/minestom/lib/1.0/lib-1.0.jar", "x");
    expect(res.status).toBe(400);
  });

  it("rejects an invalid layout path", async () => {
    const res = await put("releases/net/minestom/../escape", "x");
    expect(res.status).toBe(400);
  });
});

describe("deploy: immutability", () => {
  it("rejects re-deploying an existing release artifact with 409", async () => {
    expect((await put(`releases/${REL}`, "v1")).status).toBe(201);
    expect((await put(`releases/${REL}`, "v2")).status).toBe(409);
    const get = await SELF.fetch(`${BASE}/releases/${REL}`);
    expect(await get.text()).toBe("v1");
  });

  it("allows re-deploying snapshot builds (mutable)", async () => {
    const path =
      "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT/minestom-1.6.0-20260101.000000-1.jar";
    expect((await put(path, "a")).status).toBe(201);
    expect((await put(path, "b")).status).toBe(201);
  });
});

describe("deploy: generated resources are discarded", () => {
  it("accepts but does not store client metadata or checksums", async () => {
    expect((await put("releases/net/minestom/minestom/maven-metadata.xml", "<m/>")).status).toBe(
      200,
    );
    expect((await put(`releases/${REL}.sha1`, "abc")).status).toBe(200);
    // Nothing stored: generation lands in M2, so these are absent for now.
    expect(await env.BUCKET.get("releases/net/minestom/minestom/maven-metadata.xml")).toBeNull();
    expect(await env.BUCKET.get(`releases/${REL}.sha1`)).toBeNull();
  });
});

describe("deploy: key rotation", () => {
  it("supports multiple live keys and immediate revocation", async () => {
    const id = await createAccount("rot");
    await addNamespace(id, "com.rot");
    await addKey(id, "old");
    await addKey(id, "new");
    const base = "releases/com/rot/lib";

    expect((await put(`${base}/1.0/lib-1.0.jar`, "x", basicAuth("rot", "old"))).status).toBe(201);
    expect((await put(`${base}/2.0/lib-2.0.jar`, "x", basicAuth("rot", "new"))).status).toBe(201);

    // Revoke only the 'old' key; 'new' keeps working — zero-downtime rotation.
    await env.DB.prepare("UPDATE deploy_keys SET revoked_at = ?1 WHERE key_hash = ?2")
      .bind(Date.now(), await sha256Hex("old"))
      .run();

    expect((await put(`${base}/3.0/lib-3.0.jar`, "x", basicAuth("rot", "old"))).status).toBe(401);
    expect((await put(`${base}/4.0/lib-4.0.jar`, "x", basicAuth("rot", "new"))).status).toBe(201);
  });
});
