import { describe, expect, it } from "vitest";
import { parseBasicAuth, sha256Hex } from "../../src/auth";
import { accountOwnsGroup } from "../../src/db";

describe("parseBasicAuth", () => {
  it("parses valid credentials", () => {
    const header = `Basic ${btoa("minestom:secret:with:colons")}`;
    expect(parseBasicAuth(header)).toEqual({
      username: "minestom",
      password: "secret:with:colons",
    });
  });

  it("rejects malformed headers", () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth("Basic !!!not-base64!!!")).toBeNull();
    expect(parseBasicAuth(`Basic ${btoa("no-colon")}`)).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("accountOwnsGroup", () => {
  it("matches exact and dotted-prefix groups", () => {
    const prefixes = ["net.minestom"];
    expect(accountOwnsGroup(prefixes, "net.minestom")).toBe(true);
    expect(accountOwnsGroup(prefixes, "net.minestom.server")).toBe(true);
    expect(accountOwnsGroup(prefixes, "net.minestomx")).toBe(false);
    expect(accountOwnsGroup(prefixes, "net")).toBe(false);
    expect(accountOwnsGroup(prefixes, "com.other")).toBe(false);
    expect(accountOwnsGroup([], "net.minestom")).toBe(false);
  });
});
