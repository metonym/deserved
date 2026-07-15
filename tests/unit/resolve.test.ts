import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCandidates,
  realContainedPath,
  safeJoin,
} from "../../src/handlers";

describe("buildCandidates", () => {
  test("root becomes index.html", () => {
    expect(buildCandidates("")).toEqual(["index.html"]);
    expect(buildCandidates(".")).toEqual(["index.html"]);
  });

  test("bare path tries file, .html, then index", () => {
    expect(buildCandidates("about")).toEqual([
      "about",
      "about.html",
      "about/index.html",
    ]);
  });

  test("trailing slash only tries directory index", () => {
    expect(buildCandidates("about/")).toEqual(["about/index.html"]);
  });
});

describe("safeJoin", () => {
  test("blocks path traversal", () => {
    expect(safeJoin("/tmp/site", "../etc/passwd")).toBeNull();
    expect(safeJoin("/tmp/site", "ok/../../etc/passwd")).toBeNull();
  });

  test("keeps paths under root", () => {
    const joined = safeJoin("/tmp/site", "css/app.css");
    expect(joined).toBeTruthy();
    expect(joined?.endsWith("css/app.css")).toBe(true);
  });
});

describe("realContainedPath", () => {
  test("blocks a symlink that resolves outside root", () => {
    const base = mkdtempSync(join(tmpdir(), "deserved-real-"));
    const outside = join(base, "outside");
    const root = join(base, "root");
    mkdirSync(outside, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, join(root, "escape"));

    try {
      expect(
        realContainedPath(root, join(root, "escape", "secret.txt")),
      ).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("allows a symlink that resolves inside root", () => {
    const base = mkdtempSync(join(tmpdir(), "deserved-real-"));
    const root = join(base, "root");
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "file.txt"), "hi");
    symlinkSync(join(root, "real"), join(root, "alias"));

    try {
      const real = realContainedPath(root, join(root, "alias", "file.txt"));
      expect(real).toBeTruthy();
      expect(real?.endsWith(join("real", "file.txt"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("returns null for a path that does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "deserved-real-"));
    try {
      expect(realContainedPath(base, join(base, "nope.txt"))).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("returns null when the root itself does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "deserved-real-"));
    const missingRoot = join(base, "nope");
    try {
      expect(
        realContainedPath(missingRoot, join(missingRoot, "file.txt")),
      ).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
