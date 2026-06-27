import type { Env } from "./types";
import { parseBasicAuth, sha256Hex } from "./auth";
import { r2Key, type ResolvedRepo } from "./config";
import {
  basename,
  classifyPath,
  type Resource,
  resourceGroupId,
  resourceVersion,
} from "./coordinates";
import {
  type Account,
  accountOwnsGroup,
  authenticate,
  deleteArtifact,
  insertAudit,
  markVerified,
  ownedPrefixes,
  recordArtifact,
} from "./db";
import { contentTypeFor, textResponse } from "./http";
import { verifyDetachedSignature } from "./signatures";

const SIGNATURE_CONTENT_TYPE = "application/pgp-signature";

function unauthorized(): Response {
  return textResponse(401, "Unauthorized", {
    "WWW-Authenticate": 'Basic realm="maven", charset="UTF-8"',
  });
}

const releaseUnsigned = (): Response =>
  textResponse(403, "Releases must be signed; configure a PGP public key for this account");

/** A snapshot version must go to a snapshot repo and vice-versa; group metadata fits both. */
function repoMatchesResource(repo: ResolvedRepo["repo"], resource: Resource): boolean {
  const version = resourceVersion(resource);
  if (version === null) return true;
  const isSnapshot = version.endsWith("-SNAPSHOT");
  return repo === "snapshot" ? isSnapshot : !isSnapshot;
}

/** Resources we generate ourselves and therefore accept-and-discard on upload. */
function isGenerated(resource: Resource): boolean {
  return (
    resource.kind === "checksum" ||
    resource.kind === "group-metadata" ||
    resource.kind === "snapshot-metadata"
  );
}

async function authenticateRequest(request: Request, env: Env): Promise<Account | null> {
  const creds = parseBasicAuth(request.headers.get("Authorization"));
  if (creds === null) return null;
  const keyHash = await sha256Hex(creds.password);
  return authenticate(env.DB, creds.username, keyHash, Date.now());
}

async function storeBody(
  env: Env,
  key: string,
  request: Request,
  contentType: string,
): Promise<void> {
  await env.BUCKET.put(key, request.body ?? new Uint8Array(), { httpMetadata: { contentType } });
}

async function audit(env: Env, account: Account, request: Request, key: string): Promise<void> {
  await insertAudit(
    env.DB,
    account.id,
    "PUT",
    key,
    Date.now(),
    request.headers.get("CF-Connecting-IP"),
  );
}

/** Deploy a primary artifact. Releases land hidden (`verified=0`) until a signature verifies. */
async function handleArtifactUpload(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
  account: Account,
  resource: Extract<Resource, { kind: "artifact" }>,
): Promise<Response> {
  if (resolved.repo === "release" && account.publicPgpKey === null) return releaseUnsigned();

  const key = r2Key(resolved);
  if (resolved.repo === "release" && (await env.BUCKET.head(key)) !== null) {
    return textResponse(409, "Release artifacts are immutable");
  }

  await storeBody(env, key, request, contentTypeFor(basename(resolved.relPath)));
  await recordArtifact(env.DB, {
    key,
    accountId: account.id,
    repo: resolved.repo,
    groupId: resource.coord.groupId,
    artifactId: resource.coord.artifactId,
    version: resource.coord.version,
    filename: resource.coord.filename,
    extension: resource.coord.extension,
    classifier: resource.coord.classifier,
    verified: resolved.repo === "release" ? 0 : 1,
    deployedAt: Date.now(),
  });
  await audit(env, account, request, key);
  return textResponse(201, "Created");
}

/**
 * Handle a `.asc` upload. Snapshots are stored unverified. For releases we verify the detached
 * signature against the account's public key: valid → store + mark the artifact visible; invalid
 * → delete the artifact so it never becomes downloadable.
 */
async function handleSignatureUpload(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
  account: Account,
): Promise<Response> {
  const ascKey = r2Key(resolved);
  if (resolved.repo === "release" && (await env.BUCKET.head(ascKey)) !== null) {
    return textResponse(409, "Release artifacts are immutable");
  }

  if (resolved.repo === "snapshot") {
    await storeBody(env, ascKey, request, SIGNATURE_CONTENT_TYPE);
    await audit(env, account, request, ascKey);
    return textResponse(201, "Created");
  }

  if (account.publicPgpKey === null) return releaseUnsigned();

  const targetKey = r2Key(resolved, resolved.relPath.slice(0, -".asc".length));
  const artifact = await env.BUCKET.get(targetKey);
  if (artifact === null) {
    return textResponse(400, "The signed artifact must be uploaded before its signature");
  }

  const data = new Uint8Array(await artifact.arrayBuffer());
  const signatureArmored = await request.text();
  if (!(await verifyDetachedSignature(account.publicPgpKey, data, signatureArmored))) {
    // Reject and remove the unverifiable artifact so it can never be served.
    await env.BUCKET.delete(targetKey);
    await deleteArtifact(env.DB, targetKey);
    return textResponse(400, "Signature verification failed");
  }

  await env.BUCKET.put(ascKey, signatureArmored, {
    httpMetadata: { contentType: SIGNATURE_CONTENT_TYPE },
  });
  await markVerified(env.DB, targetKey);
  await audit(env, account, request, ascKey);
  return textResponse(201, "Created");
}

/** Handle an authenticated deploy (`PUT`). */
export async function handlePut(
  request: Request,
  env: Env,
  resolved: ResolvedRepo,
): Promise<Response> {
  const account = await authenticateRequest(request, env);
  if (account === null) return unauthorized();

  const resource = classifyPath(resolved.relPath);
  if (resource === null) return textResponse(400, "Invalid repository path");

  const groupId = resourceGroupId(resource);
  const prefixes = await ownedPrefixes(env.DB, account.id);
  if (!accountOwnsGroup(prefixes, groupId)) {
    return textResponse(403, `Account '${account.name}' does not own namespace '${groupId}'`);
  }

  if (!repoMatchesResource(resolved.repo, resource)) {
    return textResponse(400, `Version does not match the ${resolved.repo} repository`);
  }

  // Metadata + checksums are generated by us; accept and discard the client's copy.
  if (isGenerated(resource)) return textResponse(200, "OK");

  if (resource.kind === "signature") {
    return handleSignatureUpload(request, env, resolved, account);
  }
  if (resource.kind === "artifact") {
    return handleArtifactUpload(request, env, resolved, account, resource);
  }
  // Unreachable: metadata/checksum resources are handled above.
  return textResponse(400, "Invalid repository path");
}
