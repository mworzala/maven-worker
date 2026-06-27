import * as openpgp from "openpgp";

/**
 * Verify a detached PGP signature against the data it should cover, using the account's armored
 * public key. Returns false on any failure (bad key, bad signature, tampered data).
 */
export async function verifyDetachedSignature(
  publicKeyArmored: string,
  data: Uint8Array,
  signatureArmored: string,
): Promise<boolean> {
  try {
    const verificationKeys = await openpgp.readKey({ armoredKey: publicKeyArmored });
    const signature = await openpgp.readSignature({ armoredSignature: signatureArmored });
    const message = await openpgp.createMessage({ binary: data });
    const result = await openpgp.verify({ message, signature, verificationKeys });
    return await result.signatures[0]!.verified;
  } catch {
    return false;
  }
}
