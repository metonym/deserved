import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryListing, listDir } from "../../src/handlers";

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
});
