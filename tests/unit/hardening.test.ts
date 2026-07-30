import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPRESSED_CACHE_BYTE_BUDGET,
  createHandler,
  RESOLUTION_CACHE_LIMIT,
  RESOLUTION_TTL_MS,
} from "../../src/handlers";
import type { Options } from "../../src/server";
import { formatUrl } from "../../src/server";

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

describe("malformed percent-encoding", () => {
  const root = mkdtempSync(join(tmpdir(), "hardening-"));
  writeFileSync(join(root, "file.txt"), "hello");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("GET /%zz returns 400", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/%zz"));
    expect(res.status).toBe(400);
  });

  test("GET /% returns 400", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/%"));
    expect(res.status).toBe(400);
  });

  test("400 carries CORS header when cors is enabled", async () => {
    const handle = createHandler(makeOpts(root, { cors: true }));
    const res = await handle(new Request("http://x/%zz"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("Vary: Accept-Encoding", () => {
  const root = mkdtempSync(join(tmpdir(), "hardening-vary-"));
  writeFileSync(join(root, "file.txt"), "hello world ".repeat(50));
  writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("identity response to compressible file has Vary", async () => {
    const handle = createHandler(makeOpts(root, { compress: true }));
    const res = await handle(new Request("http://x/file.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
  });

  test("gzip response has exactly one Vary value", async () => {
    const handle = createHandler(makeOpts(root, { compress: true }));
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { "Accept-Encoding": "gzip" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
  });

  test("non-compressible file has no Vary", async () => {
    const handle = createHandler(makeOpts(root, { compress: true }));
    const res = await handle(new Request("http://x/image.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Vary")).toBeNull();
  });

  test("304 for a compressible file has Vary", async () => {
    const handle = createHandler(makeOpts(root, { compress: true }));
    const first = await handle(new Request("http://x/file.txt"));
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { "If-None-Match": etag ?? "" },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
  });
});

describe("416 keeps base headers", () => {
  const root = mkdtempSync(join(tmpdir(), "hardening-416-"));
  writeFileSync(join(root, "file.txt"), "0123456789");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("out-of-range request returns 416 with ETag and Content-Range", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { Range: "bytes=999999-" },
      }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
    expect(res.headers.get("ETag")).toBeTruthy();
  });
});

describe("formatUrl", () => {
  test("plain hostname is unbracketed", () => {
    expect(formatUrl("localhost", 3000)).toBe("http://localhost:3000");
  });

  test("IPv6 host is bracketed", () => {
    expect(formatUrl("::1", 3000)).toBe("http://[::1]:3000");
  });
});

describe("resolution cache: content freshness", () => {
  test("an edit is visible on the very next request, watch or not", async () => {
    for (const watch of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "rescache-fresh-"));
      try {
        const path = join(root, "file.txt");
        writeFileSync(path, "before");
        const handle = createHandler(makeOpts(root, { watch }));

        const first = await handle(new Request("http://x/file.txt"));
        expect(await first.text()).toBe("before");

        writeFileSync(path, "after");
        const second = await handle(new Request("http://x/file.txt"));
        expect(await second.text()).toBe("after");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("resolution cache: watch-mode invalidation", () => {
  test("a newly created file stays 404 until invalidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "rescache-watch-new-"));
    try {
      const handle = createHandler(makeOpts(root, { watch: true }));

      const before = await handle(new Request("http://x/new.txt"));
      expect(before.status).toBe(404);

      writeFileSync(join(root, "new.txt"), "hello");

      const stillCached = await handle(new Request("http://x/new.txt"));
      expect(stillCached.status).toBe(404);

      handle.invalidateResolutionCache();

      const afterInvalidate = await handle(new Request("http://x/new.txt"));
      expect(afterInvalidate.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink swapped in after caching is rejected once invalidated", async () => {
    const root = mkdtempSync(join(tmpdir(), "rescache-watch-poison-"));
    const outside = mkdtempSync(join(tmpdir(), "rescache-watch-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "top secret");
      writeFileSync(join(root, "target.txt"), "safe content");

      const handle = createHandler(makeOpts(root, { watch: true }));
      const first = await handle(new Request("http://x/target.txt"));
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("safe content");

      unlinkSync(join(root, "target.txt"));
      symlinkSync(join(outside, "secret.txt"), join(root, "target.txt"));
      handle.invalidateResolutionCache();

      const afterSwap = await handle(new Request("http://x/target.txt"));
      expect(afterSwap.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolution cache: non-watch TTL", () => {
  test("a newly created file stays 404 until the TTL expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "rescache-ttl-new-"));
    try {
      const handle = createHandler(makeOpts(root, { watch: false }));

      const before = await handle(new Request("http://x/new.txt"));
      expect(before.status).toBe(404);

      writeFileSync(join(root, "new.txt"), "hello");

      const stillCached = await handle(new Request("http://x/new.txt"));
      expect(stillCached.status).toBe(404);

      await Bun.sleep(RESOLUTION_TTL_MS + 150);

      const afterExpiry = await handle(new Request("http://x/new.txt"));
      expect(afterExpiry.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 5000);

  test("a symlink swapped in after caching is rejected once the TTL expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "rescache-ttl-poison-"));
    const outside = mkdtempSync(join(tmpdir(), "rescache-ttl-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "top secret");
      writeFileSync(join(root, "target.txt"), "safe content");

      const handle = createHandler(makeOpts(root, { watch: false }));
      const first = await handle(new Request("http://x/target.txt"));
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("safe content");

      unlinkSync(join(root, "target.txt"));
      symlinkSync(join(outside, "secret.txt"), join(root, "target.txt"));

      await Bun.sleep(RESOLUTION_TTL_MS + 150);

      const afterSwap = await handle(new Request("http://x/target.txt"));
      expect(afterSwap.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 5000);
});

describe("resolution cache: memory bound", () => {
  test("5000 distinct misses do not grow the cache unbounded", async () => {
    const root = mkdtempSync(join(tmpdir(), "rescache-cap-"));
    try {
      const handle = createHandler(makeOpts(root));
      for (let i = 0; i < 5000; i++) {
        await handle(new Request(`http://x/missing-${i}`));
      }
      expect(handle.resolutionCacheSize()).toBeLessThanOrEqual(
        RESOLUTION_CACHE_LIMIT,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe("compressed cache: memory bound", () => {
  test("many distinct compressed files stay within the byte budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "compcache-cap-"));
    try {
      const handle = createHandler(makeOpts(root, { compress: true }));
      // Low-compressibility (random) content close to the per-file 2MB
      // compression cutoff, so the compressed cache fills up in relatively
      // few requests instead of needing gigabytes of fixture data.
      const fileCount = 40;
      const fileSize = 1_900_000;
      const chunk = 65536;
      for (let i = 0; i < fileCount; i++) {
        const bytes = new Uint8Array(fileSize);
        for (let o = 0; o < fileSize; o += chunk) {
          crypto.getRandomValues(
            bytes.subarray(o, Math.min(o + chunk, fileSize)),
          );
        }
        writeFileSync(join(root, `f${i}.txt`), bytes);
      }

      for (let i = 0; i < fileCount; i++) {
        const res = await handle(
          new Request(`http://x/f${i}.txt`, {
            headers: { "Accept-Encoding": "gzip" },
          }),
        );
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }

      expect(handle.compressedCacheBytes()).toBeLessThanOrEqual(
        COMPRESSED_CACHE_BYTE_BUDGET,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe("compressed cache: watch-mode invalidation", () => {
  test("invalidateCompressedCache drops all retained compressed bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "compcache-watch-"));
    try {
      writeFileSync(join(root, "old.txt"), "hello world ".repeat(2000));
      const handle = createHandler(
        makeOpts(root, { compress: true, watch: true }),
      );

      expect(handle.compressedCacheBytes()).toBe(0);
      const res = await handle(
        new Request("http://x/old.txt", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect(handle.compressedCacheBytes()).toBeGreaterThan(0);

      // Simulates a bundler rebuild dropping a content-hashed file: it's
      // deleted and never requested again, so only the watcher's
      // invalidation signal -- not a cache hit/miss on this path -- can
      // ever reclaim its bytes.
      unlinkSync(join(root, "old.txt"));
      handle.invalidateCompressedCache();

      expect(handle.compressedCacheBytes()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("compressed cache: instance isolation", () => {
  test("one handler's cached bytes are invisible to another", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "compcache-iso-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "compcache-iso-b-"));
    try {
      writeFileSync(join(rootA, "file.txt"), "hello world ".repeat(2000));
      writeFileSync(join(rootB, "file.txt"), "hello world ".repeat(2000));

      const handleA = createHandler(makeOpts(rootA, { compress: true }));
      const resA = await handleA(
        new Request("http://x/file.txt", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(resA.status).toBe(200);
      await resA.arrayBuffer();
      expect(handleA.compressedCacheBytes()).toBeGreaterThan(0);

      // A second, independent handler starts with nothing cached, and
      // clearing it must not touch the first handler's entries -- each
      // createHandler() call owns its own cache, not a shared global one.
      const handleB = createHandler(makeOpts(rootB, { compress: true }));
      expect(handleB.compressedCacheBytes()).toBe(0);
      handleB.invalidateCompressedCache();
      expect(handleA.compressedCacheBytes()).toBeGreaterThan(0);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
