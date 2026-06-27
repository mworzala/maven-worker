import type { Env } from "./types";
import { loadRepositories, resolveRepo } from "./config";
import { classifyPath } from "./coordinates";
import { handleRead } from "./read";
import { handleBrowse } from "./browse";
import { methodNotAllowed, notFound, textResponse } from "./http";

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const resolved = resolveRepo(loadRepositories(env), url.hostname, url.pathname);
  if (resolved === null) return notFound();

  switch (request.method) {
    case "GET":
    case "HEAD": {
      if (resolved.relPath === "" || resolved.relPath.endsWith("/")) {
        return handleBrowse(request, env, resolved);
      }
      const resource = classifyPath(resolved.relPath);
      if (resource === null) return handleBrowse(request, env, resolved);
      return handleRead(request, env, resolved, resource);
    }
    case "PUT":
      return textResponse(501, "Not Implemented");
    default:
      return methodNotAllowed("GET, HEAD, PUT");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error("unhandled error", err);
      return textResponse(500, "Internal Server Error");
    }
  },
} satisfies ExportedHandler<Env>;
