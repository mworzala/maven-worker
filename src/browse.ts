import type { Env } from "./types";
import { notFound } from "./http";
import type { ResolvedRepo } from "./config";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface Entry {
  name: string;
  href: string;
  size: string;
  modified: string;
}

function renderIndex(displayPath: string, parent: string | null, entries: Entry[]): string {
  const rows = entries
    .map(
      (e) =>
        `<a href="${escapeHtml(e.href)}">${escapeHtml(e.name)}</a>${" ".repeat(
          Math.max(1, 50 - e.name.length),
        )}${e.modified}${" ".repeat(Math.max(1, 22 - e.modified.length))}${e.size}`,
    )
    .join("\n");
  const up = parent === null ? "" : `<a href="${escapeHtml(parent)}">../</a>\n`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Index of ${escapeHtml(displayPath)}</title></head>
<body><h1>Index of ${escapeHtml(displayPath)}</h1><hr><pre>${up}${rows}</pre><hr></body></html>
`;
}

/** Generate a Maven-Central-style HTML directory index from an R2 prefix listing. */
export async function handleBrowse(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
): Promise<Response> {
  const rel = resolved.relPath.replace(/\/+$/, "");
  const prefix = rel === "" ? `${resolved.r2Prefix}/` : `${resolved.r2Prefix}/${rel}/`;

  const dirs: string[] = [];
  const files: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ prefix, delimiter: "/", cursor });
    dirs.push(...list.delimitedPrefixes);
    files.push(...list.objects);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  if (dirs.length === 0 && files.length === 0) return notFound();

  const entries: Entry[] = [
    ...dirs.map((d) => {
      const name = `${d.slice(prefix.length)}`;
      return { name, href: name, size: "-", modified: "-" };
    }),
    ...files.map((o) => {
      const name = o.key.slice(prefix.length);
      return { name, href: name, size: String(o.size), modified: o.uploaded.toISOString() };
    }),
  ].toSorted((a, b) => a.name.localeCompare(b.name));

  const displayPath = `/${rel}${rel === "" ? "" : "/"}`;
  const parent = rel === "" ? null : "../";
  const html = renderIndex(displayPath, parent, entries);

  const headers = {
    "Content-Type": "text/html;charset=utf-8",
    "Cache-Control": "public, max-age=60",
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(html, { headers });
}
