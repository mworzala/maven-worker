import { describe, expect, it } from "vitest";
import { verifyDetachedSignature } from "../../src/signatures";
import { generateKeypair, signDetached } from "../helpers";

describe("verifyDetachedSignature", () => {
  it("accepts a valid signature", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const data = "the artifact bytes";
    const sig = await signDetached(privateKey, data);
    expect(await verifyDetachedSignature(publicKey, new TextEncoder().encode(data), sig)).toBe(
      true,
    );
  });

  it("rejects a signature over different data", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const sig = await signDetached(privateKey, "original");
    expect(
      await verifyDetachedSignature(publicKey, new TextEncoder().encode("tampered"), sig),
    ).toBe(false);
  });

  it("rejects a signature from the wrong key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const sig = await signDetached(b.privateKey, "data");
    expect(await verifyDetachedSignature(a.publicKey, new TextEncoder().encode("data"), sig)).toBe(
      false,
    );
  });

  it("returns false for malformed input", async () => {
    const { publicKey } = await generateKeypair();
    expect(await verifyDetachedSignature(publicKey, new TextEncoder().encode("x"), "junk")).toBe(
      false,
    );
    expect(await verifyDetachedSignature("not a key", new TextEncoder().encode("x"), "junk")).toBe(
      false,
    );
  });
});
