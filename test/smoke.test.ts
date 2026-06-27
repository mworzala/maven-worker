import { createHash } from "node:crypto";
import { SELF, env } from "cloudflare:test";
import * as openpgp from "openpgp";
import { describe, expect, it } from "vitest";

describe("runtime smoke", () => {
  it("node:crypto computes md5/sha1/sha256/sha512", () => {
    expect(createHash("md5").update("abc").digest("hex")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(createHash("sha1").update("abc").digest("hex")).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
    expect(createHash("sha256").update("abc").digest("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(createHash("sha512").update("abc").digest("hex").slice(0, 16)).toBe("ddaf35a193617aba");
  });

  it("openpgp is usable in the worker runtime", () => {
    expect(typeof openpgp.verify).toBe("function");
    expect(typeof openpgp.readKey).toBe("function");
  });

  it("D1 migrations applied (artifacts table exists)", async () => {
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("worker responds (root is an unmapped path → 404)", async () => {
    const res = await SELF.fetch("https://repo.example.com/");
    expect(res.status).toBe(404);
  });
});
