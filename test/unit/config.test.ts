import { describe, expect, it } from "vitest";
import { loadRepositories, r2Key, resolveRepo } from "../../src/config";
import type { Env, RepositoryConfig } from "../../src/types";

const DEFAULT: RepositoryConfig[] = [
  { host: "*", prefix: "/releases", repo: "release", r2Prefix: "releases" },
  { host: "*", prefix: "/snapshots", repo: "snapshot", r2Prefix: "snapshots" },
];

describe("loadRepositories", () => {
  it("accepts an array binding", () => {
    expect(loadRepositories({ REPOSITORIES: DEFAULT } as Env)).toEqual(DEFAULT);
  });

  it("accepts a JSON string binding", () => {
    expect(loadRepositories({ REPOSITORIES: JSON.stringify(DEFAULT) } as Env)).toEqual(DEFAULT);
  });

  it("rejects a non-array", () => {
    expect(() => loadRepositories({ REPOSITORIES: "{}" } as Env)).toThrow();
  });

  it("rejects an invalid entry", () => {
    const bad = [{ host: "*", prefix: "/x", repo: "bogus", r2Prefix: "x" }];
    expect(() => loadRepositories({ REPOSITORIES: bad } as unknown as Env)).toThrow();
  });
});

describe("resolveRepo", () => {
  it("maps the releases prefix", () => {
    const r = resolveRepo(DEFAULT, "repo.example.com", "/releases/net/x/x/1.0/x-1.0.jar");
    expect(r).toEqual({ repo: "release", r2Prefix: "releases", relPath: "net/x/x/1.0/x-1.0.jar" });
  });

  it("maps the snapshots prefix", () => {
    const r = resolveRepo(
      DEFAULT,
      "repo.example.com",
      "/snapshots/g/a/1.0-SNAPSHOT/maven-metadata.xml",
    );
    expect(r?.repo).toBe("snapshot");
    expect(r?.relPath).toBe("g/a/1.0-SNAPSHOT/maven-metadata.xml");
  });

  it("returns the mount root with empty relPath", () => {
    const r = resolveRepo(DEFAULT, "h", "/releases");
    expect(r?.relPath).toBe("");
  });

  it("returns null for an unmapped path", () => {
    expect(resolveRepo(DEFAULT, "h", "/")).toBeNull();
    expect(resolveRepo(DEFAULT, "h", "/other/x")).toBeNull();
  });

  it("prefers an exact host over a wildcard", () => {
    const repos: RepositoryConfig[] = [
      { host: "*", prefix: "/maven2", repo: "snapshot", r2Prefix: "wild" },
      { host: "repo.example.com", prefix: "/maven2", repo: "release", r2Prefix: "exact" },
    ];
    const r = resolveRepo(repos, "repo.example.com", "/maven2/g/a/1.0/a-1.0.jar");
    expect(r?.r2Prefix).toBe("exact");
  });

  it("prefers the longest matching prefix", () => {
    const repos: RepositoryConfig[] = [
      { host: "*", prefix: "/", repo: "release", r2Prefix: "root" },
      { host: "*", prefix: "/snapshots", repo: "snapshot", r2Prefix: "snapshots" },
    ];
    expect(resolveRepo(repos, "h", "/snapshots/g/a/1.0/a-1.0.jar")?.r2Prefix).toBe("snapshots");
    expect(resolveRepo(repos, "h", "/g/a/1.0/a-1.0.jar")?.r2Prefix).toBe("root");
  });

  it("supports a custom host+subpath mount (minestom-style)", () => {
    const repos: RepositoryConfig[] = [
      { host: "minestom.net", prefix: "/maven2", repo: "release", r2Prefix: "releases" },
      { host: "snapshots.minestom.net", prefix: "/", repo: "snapshot", r2Prefix: "snapshots" },
    ];
    const rel = resolveRepo(
      repos,
      "minestom.net",
      "/maven2/net/minestom/minestom/1.5.0/minestom-1.5.0.jar",
    );
    expect(rel).toEqual({
      repo: "release",
      r2Prefix: "releases",
      relPath: "net/minestom/minestom/1.5.0/minestom-1.5.0.jar",
    });
    const snap = resolveRepo(
      repos,
      "snapshots.minestom.net",
      "/net/minestom/minestom/maven-metadata.xml",
    );
    expect(snap?.repo).toBe("snapshot");
    expect(snap?.relPath).toBe("net/minestom/minestom/maven-metadata.xml");
  });
});

describe("r2Key", () => {
  it("joins prefix and relPath", () => {
    expect(r2Key({ repo: "release", r2Prefix: "releases", relPath: "g/a/1.0/a-1.0.jar" })).toBe(
      "releases/g/a/1.0/a-1.0.jar",
    );
  });
});
