export interface BasicCredentials {
  username: string;
  password: string;
}

/** Parse an HTTP Basic `Authorization` header. */
export function parseBasicAuth(header: string | null): BasicCredentials | null {
  if (header === null || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** Hex SHA-256 of a string, used to store/compare deploy keys without keeping the secret. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
