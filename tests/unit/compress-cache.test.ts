import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
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
    compress: true,
    quiet: true,
    ...overrides,
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

  test("caches zstd and gzip separately for the same file", async () => {
    const root = mkdtempSync(join(tmpdir(), "zstd-cache-"));
    try {
      writeFileSync(join(root, "index.html"), `<h1>${"x".repeat(2000)}</h1>`);
      const handle = createHandler(makeOpts(root));

      const zstdRes = await handle(
        new Request("http://x/", {
          headers: { "Accept-Encoding": "gzip, zstd" },
        }),
      );
      const gzipRes = await handle(
        new Request("http://x/", { headers: { "Accept-Encoding": "gzip" } }),
      );

      expect(zstdRes.headers.get("Content-Encoding")).toBe("zstd");
      expect(gzipRes.headers.get("Content-Encoding")).toBe("gzip");

      const zstdBytes = new Uint8Array(await zstdRes.arrayBuffer());
      const gzipBytes = new Uint8Array(await gzipRes.arrayBuffer());
      expect(
        new TextDecoder().decode(Bun.zstdDecompressSync(zstdBytes)),
      ).toContain("x".repeat(2000));
      expect(new TextDecoder().decode(Bun.gunzipSync(gzipBytes))).toContain(
        "x".repeat(2000),
      );
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

describe("watch-mode compressed output cache", () => {
  test("second identical request reuses the cached zstd without re-reading or re-compressing", async () => {
    const root = mkdtempSync(join(tmpdir(), "zstd-watch-cache-"));
    try {
      writeFileSync(join(root, "index.html"), `<h1>${"x".repeat(2000)}</h1>`);
      const handle = createHandler(makeOpts(root, { watch: true }));
      const req = () =>
        new Request("http://x/", { headers: { "Accept-Encoding": "zstd" } });

      const zstdSpy = spyOn(Bun, "zstdCompress");
      try {
        const first = await handle(req());
        const firstBytes = new Uint8Array(await first.arrayBuffer());
        expect(first.headers.get("Content-Encoding")).toBe("zstd");
        expect(zstdSpy).toHaveBeenCalledTimes(1);

        const second = await handle(req());
        const secondBytes = new Uint8Array(await second.arrayBuffer());
        expect(secondBytes).toEqual(firstBytes);
        // Cache hit: no re-compress (and therefore no re-read of the file).
        expect(zstdSpy).toHaveBeenCalledTimes(1);

        expect(
          new TextDecoder().decode(Bun.zstdDecompressSync(secondBytes)),
        ).toContain("/__live.js");
      } finally {
        zstdSpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recompresses the injected HTML once the file's (size, mtime) changes on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "gzip-watch-stale-"));
    try {
      const path = join(root, "index.html");
      writeFileSync(path, `<h1>${"x".repeat(2000)}</h1>`);
      const handle = createHandler(makeOpts(root, { watch: true }));
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
      const decoded = new TextDecoder().decode(Bun.gunzipSync(secondBytes));
      expect(decoded).toContain("y".repeat(2500));
      expect(decoded).toContain("/__live.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("async compression round-trips", () => {
  test("gzip output decompresses with Bun.gunzipSync", async () => {
    const root = mkdtempSync(join(tmpdir(), "gzip-roundtrip-"));
    try {
      writeFileSync(join(root, "index.html"), `<h1>${"a".repeat(3000)}</h1>`);
      const handle = createHandler(makeOpts(root));

      const res = await handle(
        new Request("http://x/", { headers: { "Accept-Encoding": "gzip" } }),
      );
      expect(res.headers.get("Content-Encoding")).toBe("gzip");

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toContain(
        "a".repeat(3000),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("zstd output decompresses with Bun.zstdDecompressSync", async () => {
    const root = mkdtempSync(join(tmpdir(), "zstd-roundtrip-"));
    try {
      writeFileSync(join(root, "index.html"), `<h1>${"b".repeat(3000)}</h1>`);
      const handle = createHandler(makeOpts(root));

      const res = await handle(
        new Request("http://x/", { headers: { "Accept-Encoding": "zstd" } }),
      );
      expect(res.headers.get("Content-Encoding")).toBe("zstd");

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(Bun.zstdDecompressSync(bytes))).toContain(
        "b".repeat(3000),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("single-flight compression", () => {
  test("10 concurrent cold requests for the same file compress exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "single-flight-"));
    try {
      writeFileSync(join(root, "index.html"), `<h1>${"z".repeat(5000)}</h1>`);
      const handle = createHandler(makeOpts(root));
      const req = () =>
        new Request("http://x/", { headers: { "Accept-Encoding": "zstd" } });

      const zstdSpy = spyOn(Bun, "zstdCompress");
      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, () => handle(req())),
        );

        for (const res of responses) {
          expect(res.headers.get("Content-Encoding")).toBe("zstd");
        }

        const bodies = await Promise.all(
          responses.map(async (res) => new Uint8Array(await res.arrayBuffer())),
        );
        for (const body of bodies.slice(1)) {
          expect(body).toEqual(bodies[0]);
        }

        // Single-flight: 10 concurrent misses collapse into one compression.
        expect(zstdSpy).toHaveBeenCalledTimes(1);
      } finally {
        zstdSpy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
