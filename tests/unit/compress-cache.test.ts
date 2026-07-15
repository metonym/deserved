import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
import type { Options } from "../../src/server";

function makeOpts(root: string): Options {
  return {
    root,
    port: 0,
    host: "127.0.0.1",
    spa: false,
    watch: false,
    open: false,
    cors: false,
    dir: false,
    cache: true,
    compress: true,
    quiet: true,
  };
}

describe("compressed output cache", () => {
  test("returns byte-identical gzip output across requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "gzip-cache-"));
    try {
      writeFileSync(join(root, "index.html"), `<h1>${"x".repeat(2000)}</h1>`);
      const handle = createHandler(makeOpts(root));
      const req = () =>
        new Request("http://x/", { headers: { "Accept-Encoding": "gzip" } });

      const first = await handle(req());
      const second = await handle(req());
      expect(first.headers.get("Content-Encoding")).toBe("gzip");

      const firstBytes = new Uint8Array(await first.arrayBuffer());
      const secondBytes = new Uint8Array(await second.arrayBuffer());
      expect(secondBytes).toEqual(firstBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recompresses once the file's (size, mtime) changes on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "gzip-stale-"));
    try {
      const path = join(root, "index.html");
      writeFileSync(path, `<h1>${"x".repeat(2000)}</h1>`);
      const handle = createHandler(makeOpts(root));
      const req = () =>
        new Request("http://x/", { headers: { "Accept-Encoding": "gzip" } });

      const first = await handle(req());
      const firstBytes = new Uint8Array(await first.arrayBuffer());

      writeFileSync(path, `<h1>${"y".repeat(2500)}</h1>`);
      const future = new Date(Date.now() + 5000);
      utimesSync(path, future, future);

      const second = await handle(req());
      const secondBytes = new Uint8Array(await second.arrayBuffer());

      expect(secondBytes).not.toEqual(firstBytes);
      expect(new TextDecoder().decode(Bun.gunzipSync(secondBytes))).toContain(
        "y".repeat(2500),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
