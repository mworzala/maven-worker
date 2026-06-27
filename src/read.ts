import type { Env } from "./types";
import { cacheControlFor, contentTypeFor, notFound } from "./http";
import { r2Key, type ResolvedRepo } from "./config";
import { basename, type Resource } from "./coordinates";

function hasBody(obj: R2Object | R2ObjectBody): obj is R2ObjectBody {
  return "body" in obj;
}

function baseHeaders(obj: R2Object, filename: string, cacheControl: string): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", contentTypeFor(filename));
  headers.set("Cache-Control", cacheControl);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  return headers;
}

/** Serve a stored R2 object with content type, caching, conditional and range support. */
export async function handleRead(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
  resource: Resource,
): Promise<Response> {
  const key = r2Key(resolved);
  const filename = basename(resolved.relPath);
  const cacheControl = cacheControlFor(resolved.repo, resource);

  if (request.method === "HEAD") {
    const obj = await env.BUCKET.head(key);
    if (obj === null) return notFound();
    const headers = baseHeaders(obj, filename, cacheControl);
    headers.set("Content-Length", String(obj.size));
    return new Response(null, { status: 200, headers });
  }

  // Only forward conditional/range headers when present: passing an empty Range to R2 yields
  // a spurious full-object 206.
  const range = request.headers.has("range") ? request.headers : undefined;
  const onlyIf = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since"].some(
    (h) => request.headers.has(h),
  )
    ? request.headers
    : undefined;

  const obj = await env.BUCKET.get(key, { range, onlyIf });
  if (obj === null) return notFound();
  const headers = baseHeaders(obj, filename, cacheControl);

  if (!hasBody(obj)) {
    // A precondition (e.g. If-None-Match) was not met: no body returned.
    return new Response(null, { status: 304, headers });
  }

  // `obj.range` is populated even for full reads, so only emit 206 for an actual Range request.
  if (range !== undefined && obj.range && "offset" in obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}
