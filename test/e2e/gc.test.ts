import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { collectExpiredSnapshots, SNAPSHOT_MAX_AGE_MS } from "../../src/gc";
import { getArtifact } from "../../src/db";
import { createAccount, resetStorage, seedArtifact } from "../helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1);
const DIR = "snapshots/net/minestom/minestom/1.6.0-SNAPSHOT";

interface Build {
  ts: string;
  build: number;
  ageDays: number;
}

async function seedBuild({ ts, build, ageDays }: Build): Promise<string> {
  const filename = `minestom-1.6.0-${ts}-${build}.jar`;
  const key = `${DIR}/${filename}`;
  await seedArtifact({
    key,
    repo: "snapshot",
    groupId: "net.minestom",
    artifactId: "minestom",
    version: "1.6.0-SNAPSHOT",
    filename,
    deployedAt: NOW - ageDays * DAY,
    body: "jar",
  });
  return key;
}

beforeEach(async () => {
  await resetStorage();
  await createAccount("seed");
});

describe("snapshot GC", () => {
  it("deletes old non-newest builds and keeps the newest", async () => {
    const b1 = await seedBuild({ ts: "20260101.120000", build: 1, ageDays: 100 });
    const b2 = await seedBuild({ ts: "20260102.120000", build: 2, ageDays: 95 });
    const newest = await seedBuild({ ts: "20260301.120000", build: 3, ageDays: 1 });

    const result = await collectExpiredSnapshots(env, NOW, SNAPSHOT_MAX_AGE_MS);

    expect(result.deleted.toSorted()).toEqual([b1, b2].toSorted());
    expect(await env.BUCKET.get(b1)).toBeNull();
    expect(await env.BUCKET.get(b2)).toBeNull();
    expect(await getArtifact(env.DB, b1)).toBeNull();
    expect(await env.BUCKET.get(newest)).not.toBeNull();
    expect(await getArtifact(env.DB, newest)).not.toBeNull();
  });

  it("keeps the newest build even when it is older than the cutoff", async () => {
    const oldest = await seedBuild({ ts: "20260101.120000", build: 1, ageDays: 200 });
    const newest = await seedBuild({ ts: "20260102.120000", build: 2, ageDays: 100 });

    const result = await collectExpiredSnapshots(env, NOW, SNAPSHOT_MAX_AGE_MS);

    expect(result.deleted).toEqual([oldest]);
    expect(await env.BUCKET.get(newest)).not.toBeNull();
  });

  it("leaves recent builds untouched", async () => {
    await seedBuild({ ts: "20260101.120000", build: 1, ageDays: 10 });
    await seedBuild({ ts: "20260102.120000", build: 2, ageDays: 2 });
    const result = await collectExpiredSnapshots(env, NOW, SNAPSHOT_MAX_AGE_MS);
    expect(result.deleted).toEqual([]);
  });

  it("removes the .asc alongside an expired artifact and its index row", async () => {
    const old = await seedBuild({ ts: "20260101.120000", build: 1, ageDays: 120 });
    await env.BUCKET.put(`${old}.asc`, "sig");
    await seedBuild({ ts: "20260301.120000", build: 2, ageDays: 1 });

    await collectExpiredSnapshots(env, NOW, SNAPSHOT_MAX_AGE_MS);

    expect(await env.BUCKET.get(`${old}.asc`)).toBeNull();
    expect(await getArtifact(env.DB, old)).toBeNull();
  });

  it("never touches release artifacts", async () => {
    await seedArtifact({
      key: "releases/net/minestom/minestom/1.0.0/minestom-1.0.0.jar",
      repo: "release",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.0.0",
      filename: "minestom-1.0.0.jar",
      deployedAt: NOW - 500 * DAY,
    });
    const result = await collectExpiredSnapshots(env, NOW, SNAPSHOT_MAX_AGE_MS);
    expect(result.deleted).toEqual([]);
  });

  it("runs via the scheduled() handler", async () => {
    const now = Date.now();
    const old = `${DIR}/minestom-1.6.0-20200101.120000-1.jar`;
    await seedArtifact({
      key: old,
      repo: "snapshot",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.6.0-SNAPSHOT",
      filename: "minestom-1.6.0-20200101.120000-1.jar",
      deployedAt: now - 120 * DAY,
      body: "jar",
    });
    await seedArtifact({
      key: `${DIR}/minestom-1.6.0-20200102.120000-2.jar`,
      repo: "snapshot",
      groupId: "net.minestom",
      artifactId: "minestom",
      version: "1.6.0-SNAPSHOT",
      filename: "minestom-1.6.0-20200102.120000-2.jar",
      deployedAt: now - 100 * DAY,
      body: "jar",
    });

    const ctx = createExecutionContext();
    worker.scheduled?.({ scheduledTime: now, cron: "0 3 * * *", noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    // The oldest, non-newest build is gone; the newest (build 2) survives.
    expect(await env.BUCKET.get(old)).toBeNull();
    expect(await env.BUCKET.get(`${DIR}/minestom-1.6.0-20200102.120000-2.jar`)).not.toBeNull();
  });
});
