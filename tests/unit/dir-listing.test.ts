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
import { createHandler, directoryListing, listDir } from "../../src/handlers";
import type { Options } from "../../src/server";

function makeOpts(root: string, overrides: Partial<Options> = {}): Options {
  return {
    root,
    port: 0,
    portExplicit: false,
    host: "127.0.0.1",
    spa: false,
    watch: false,
    open: false,
    cors: false,
    dir: false,
    cache: true,
    compress: false,
    quiet: true,
    ...overrides,
  };
}

describe("listDir", () => {
  test("excludes dotfiles and sorts directories before files, alphabetically", () => {
    const dir = mkdtempSync(join(tmpdir(), "deserved-listdir-"));
    try {
      writeFileSync(join(dir, "b.txt"), "");
      writeFileSync(join(dir, "a.txt"), "");
      writeFileSync(join(dir, ".hidden"), "");
      mkdirSync(join(dir, "zdir"));

      const entries = listDir(dir);

      expect(entries.some((e) => e.name === ".hidden")).toBe(false);
      expect(entries.length).toBe(3);
      expect(entries[0].name).toBe("zdir");
      expect(entries[0].dir).toBe(true);
      expect(entries[1].name).toBe("a.txt");
      expect(entries[1].dir).toBe(false);
      expect(entries[2].name).toBe("b.txt");
      expect(entries[2].dir).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includes size and mtime for files, nulls for dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "deserved-listdir-size-"));
    try {
      writeFileSync(join(dir, "file.txt"), "hello");
      mkdirSync(join(dir, "subdir"));

      const entries = listDir(dir);

      const file = entries.find((e) => e.name === "file.txt");
      expect(file).toBeDefined();
      expect(file?.size).toBeGreaterThan(0);
      expect(file?.mtimeMs).toBeGreaterThan(0);

      const dirEntry = entries.find((e) => e.name === "subdir");
      expect(dirEntry).toBeDefined();
      expect(dirEntry?.size).toBeNull();
      expect(dirEntry?.mtimeMs).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles broken symlinks gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "deserved-listdir-symlink-"));
    try {
      symlinkSync("/nonexistent/path", join(dir, "broken"));
      writeFileSync(join(dir, "normal.txt"), "content");

      const entries = listDir(dir);

      const broken = entries.find((e) => e.name === "broken");
      expect(broken).toBeDefined();
      expect(broken?.size).toBeNull();
      expect(broken?.mtimeMs).toBeNull();

      const normal = entries.find((e) => e.name === "normal.txt");
      expect(normal).toBeDefined();
      expect(normal?.size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("directoryListing", () => {
  test("escapes HTML-special characters in filenames", () => {
    const html = directoryListing("/uploads/", [
      {
        name: "<script>alert(1)</script>.txt",
        dir: false,
        size: 100,
        mtimeMs: 1000000,
      },
      { name: 'quote"and&amp.txt', dir: false, size: 200, mtimeMs: 2000000 },
    ]);

    expect(html).not.toContain("<script>alert(1)</script>.txt");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;.txt");
    expect(html).toContain("quote&quot;and&amp;amp.txt");
  });

  test("escapes the pathname in the title and heading", () => {
    const html = directoryListing('/"><img src=x>/', []);
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  test("links each entry relative to the current directory, with a trailing slash for dirs", () => {
    const html = directoryListing("/docs", [
      { name: "guide.md", dir: false, size: 100, mtimeMs: 1000000 },
      { name: "assets", dir: true, size: null, mtimeMs: null },
    ]);

    expect(html).toContain('href="/docs/guide.md"');
    expect(html).toContain('href="/docs/assets/"');
  });

  test("includes a parent link except at root", () => {
    expect(directoryListing("/docs/", [])).toContain('href="/">../</a>');
    expect(directoryListing("/", [])).not.toContain("../</a>");
  });

  test("URI-encodes hrefs for names with #, ?, %, or spaces", () => {
    const html = directoryListing("/", [
      { name: "a#b.txt", dir: false, size: 100, mtimeMs: 1000000 },
      { name: "a?b.txt", dir: false, size: 100, mtimeMs: 1000000 },
      { name: "100% real.txt", dir: false, size: 100, mtimeMs: 1000000 },
    ]);

    expect(html).toContain('href="/a%23b.txt"');
    expect(html).toContain('href="/a%3Fb.txt"');
    expect(html).toContain('href="/100%25%20real.txt"');

    expect(html).toContain(">a#b.txt<");
    expect(html).toContain(">a?b.txt<");
    expect(html).toContain(">100% real.txt<");
  });

  test("renders file sizes in human format (B, kB, MB)", () => {
    const html = directoryListing("/", [
      { name: "tiny.txt", dir: false, size: 500, mtimeMs: 1000000 },
      { name: "medium.txt", dir: false, size: 50000, mtimeMs: 1000000 },
      { name: "large.txt", dir: false, size: 5000000, mtimeMs: 1000000 },
    ]);

    expect(html).toContain("500 B");
    expect(html).toContain("48.8 kB");
    expect(html).toContain("4.8 MB");
  });

  test("renders dirs and nulls as dash", () => {
    const html = directoryListing("/", [
      { name: "subdir", dir: true, size: null, mtimeMs: null },
      { name: "broken", dir: false, size: null, mtimeMs: null },
    ]);

    expect(html).toContain('<span class="meta">-</span>');
  });

  test("renders dates in YYYY-MM-DD HH:mm format", () => {
    const mtimeMs = new Date("2025-01-15T14:30:00Z").getTime();
    const html = directoryListing("/", [
      { name: "file.txt", dir: false, size: 100, mtimeMs },
    ]);

    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  test("round-trip: an encoded href for a % name is fetchable through the handler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deserved-listdir-roundtrip-"));
    try {
      writeFileSync(join(dir, "100% real.txt"), "hello");
      const entries = listDir(dir);
      const html = directoryListing("/", entries);

      const match = /href="([^"]+)">100% real\.txt</.exec(html);
      expect(match).not.toBeNull();
      const href = match?.[1] ?? "";

      const handle = createHandler(makeOpts(dir));
      const res = await handle(new Request(`http://x${href}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
