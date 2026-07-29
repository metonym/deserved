import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      expect(entries).toEqual([
        { name: "zdir", dir: true },
        { name: "a.txt", dir: false },
        { name: "b.txt", dir: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("directoryListing", () => {
  test("escapes HTML-special characters in filenames", () => {
    const html = directoryListing("/uploads/", [
      { name: "<script>alert(1)</script>.txt", dir: false },
      { name: 'quote"and&amp.txt', dir: false },
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
      { name: "guide.md", dir: false },
      { name: "assets", dir: true },
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
      { name: "a#b.txt", dir: false },
      { name: "a?b.txt", dir: false },
      { name: "100% real.txt", dir: false },
    ]);

    expect(html).toContain('href="/a%23b.txt"');
    expect(html).toContain('href="/a%3Fb.txt"');
    expect(html).toContain('href="/100%25%20real.txt"');

    expect(html).toContain(">a#b.txt<");
    expect(html).toContain(">a?b.txt<");
    expect(html).toContain(">100% real.txt<");
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
