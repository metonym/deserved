import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../../src/index";

const TMP = join(import.meta.dir, ".tmp-api");

function fixtureDir(name: string): string {
  mkdirSync(TMP, { recursive: true });
  const dir = join(TMP, `${name}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function removeFixture(root: string) {
  rmSync(root, { recursive: true, force: true });
}

describe("serve()", () => {
  test("starts on an ephemeral port, serves a file, and stops", async () => {
    const root = fixtureDir("basic");
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>hi</h1>");

    const server = await serve({ root, port: 0, quiet: true });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toContain(String(server.port));

      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>hi</h1>");
    } finally {
      await server.stop();
      removeFixture(root);
    }
  });

  test("watch: true starts a file watcher and stop() closes it cleanly", async () => {
    const root = fixtureDir("watch");
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>v1</h1>");

    const server = await serve({ root, port: 0, quiet: true, watch: true });
    try {
      const res = await fetch(`${server.url}/`);
      expect(await res.text()).toContain("__live.js");
    } finally {
      await server.stop();
      removeFixture(root);
    }
  });

  test("merges partial options over DEFAULT_OPTIONS", async () => {
    const root = fixtureDir("defaults");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.txt"), "hello world");

    const server = await serve({ root, port: 0, quiet: true });
    try {
      // dir listing defaults to enabled
      const listing = await fetch(`${server.url}/sub/`);
      expect(listing.status).toBe(200);
      expect(await listing.text()).toContain("a.txt");

      // compress defaults to enabled
      const compressed = await fetch(`${server.url}/sub/a.txt`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(compressed.headers.get("Content-Encoding")).toBe("gzip");

      // cors defaults to disabled
      const plain = await fetch(`${server.url}/sub/a.txt`);
      expect(plain.headers.get("Access-Control-Allow-Origin")).toBeNull();
    } finally {
      await server.stop();
      removeFixture(root);
    }
  });

  test("bind conflict rejects instead of exiting the process", async () => {
    const root = fixtureDir("conflict");
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>hi</h1>");

    const first = await serve({ root, port: 0, quiet: true });
    try {
      await expect(
        serve({ root, port: first.port, quiet: true }),
      ).rejects.toThrow(`could not bind to localhost:${first.port}`);
    } finally {
      await first.stop();
      removeFixture(root);
    }
  });
});
