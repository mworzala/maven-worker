import { createHash } from "node:crypto";
import type { Env } from "./types";
import { r2Key, type ResolvedRepo } from "./config";
import type { ChecksumAlgo, Resource } from "./coordinates";
import { cacheControlFor, generatedResponse, notFound } from "./http";
import { generateMetadataXml } from "./metadata";

/** Hex digest of a byte stream, computed incrementally (no buffering). */
export async function hashStream(
  stream: ReadableStream<Uint8Array>,
  algo: ChecksumAlgo,
): Promise<string> {
  const hash = createHash(algo);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest("hex");
}

export function hashString(text: string, algo: ChecksumAlgo): string {
  return createHash(algo).update(text).digest("hex");
}

/** Serve a generated checksum for an artifact, signature, or metadata document. */
export async function handleChecksum(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
  resource: Extract<Resource, { kind: "checksum" }>,
): Promise<Response> {
  const { target, algo } = resource;

  let digest: string | null;
  if (target.kind === "group-metadata" || target.kind === "snapshot-metadata") {
    const xml = await generateMetadataXml(env, resolved.repo, target);
    digest = xml === null ? null : hashString(xml, algo);
  } else {
    // Checksum of a stored object (artifact or signature): strip the `.<algo>` suffix.
    const targetRel = resolved.relPath.slice(0, -(algo.length + 1));
    const obj = await env.BUCKET.get(r2Key(resolved, targetRel));
    digest = obj === null ? null : await hashStream(obj.body, algo);
  }

  if (digest === null) return notFound();
  return generatedResponse(
    request,
    digest,
    "text/plain;charset=utf-8",
    cacheControlFor(resolved.repo, resource),
  );
}
