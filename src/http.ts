import { createHash } from "node:crypto";
import type { RepoKind } from "./types";
import { isMetadataResource, type Resource } from "./coordinates";

const CONTENT_TYPES: Record<string, string> = {
  jar: "application/java-archive",
  war: "application/java-archive",
  ear: "application/java-archive",
  pom: "application/xml",
  xml: "application/xml",
  module: "application/json",
  md5: "text/plain;charset=utf-8",
  sha1: "text/plain;charset=utf-8",
  sha256: "text/plain;charset=utf-8",
  sha512: "text/plain;charset=utf-8",
  asc: "application/pgp-signature",
};

export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPES[filename.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/** Cache policy: metadata is short-lived, release artifacts are immutable, snapshots short. */
export function cacheControlFor(repo: RepoKind, resource: Resource): string {
  if (isMetadataResource(resource)) return "public, max-age=60, must-revalidate";
  if (repo === "release") return "public, max-age=31536000, immutable";
  return "public, max-age=60";
}

export function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : `${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain;charset=utf-8", ...headers },
  });
}

export const notFound = (): Response => textResponse(404, "Not Found");
export const methodNotAllowed = (allow: string): Response =>
  textResponse(405, "Method Not Allowed", { Allow: allow });

/** Serve generated (non-stored) content with an ETag, HEAD and If-None-Match support. */
export function generatedResponse(
  request: Request,
  body: string,
  contentType: string,
  cacheControl: string,
): Response {
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    ETag: etag,
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
  });
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(body, { status: 200, headers });
}
