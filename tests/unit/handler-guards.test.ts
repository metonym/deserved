import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    compress: false,
    quiet: true,
    ...overrides,
  };
}

describe("Encoded traversal guard", () => {
  const root = mkdtempSync(join(tmpdir(), "traversal-guard-"));
  writeFileSync(join(root, "safe.txt"), "safe content");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("GET /..%2f..%2fetc/passwd returns 404", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/..%2f..%2fetc/passwd"));
    expect(res.status).toBe(404);
  });

  test("GET /%2e%2e/%2e%2e/etc/passwd returns 404", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/%2e%2e/%2e%2e/etc/passwd"));
    expect(res.status).toBe(404);
  });

  test("safe.txt is accessible", async () => {
    const handle = createHandler(makeOpts(root));
    const res = await handle(new Request("http://x/safe.txt"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("safe content");
  });
});

describe("2MB compression cap guard", () => {
  const root = mkdtempSync(join(tmpdir(), "compress-cap-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("2.1MB .js file is not compressed", async () => {
    const largeContent = "x".repeat(2_100_000);
    writeFileSync(join(root, "large.js"), largeContent);

    const handle = createHandler(makeOpts(root, { compress: true }));
    const res = await handle(
      new Request("http://x/large.js", {
        headers: { "Accept-Encoding": "gzip" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("2100000");
  });

  test("small .js file is compressed", async () => {
    const smallContent = "x".repeat(1000);
    writeFileSync(join(root, "small.js"), smallContent);

    const handle = createHandler(makeOpts(root, { compress: true }));
    const res = await handle(
      new Request("http://x/small.js", {
        headers: { "Accept-Encoding": "gzip" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
  });
});

describe("-live ETag divergence guard", () => {
  const root = mkdtempSync(join(tmpdir(), "etag-live-"));
  writeFileSync(join(root, "index.html"), "<h1>Hello</h1>");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("-live ETag differs from non-watch ETag", async () => {
    const watchHandler = createHandler(makeOpts(root, { watch: true }));
    const nonWatchHandler = createHandler(makeOpts(root, { watch: false }));

    const watchRes = await watchHandler(new Request("http://x/"));
    const nonWatchRes = await nonWatchHandler(new Request("http://x/"));

    const watchETag = watchRes.headers.get("ETag");
    const nonWatchETag = nonWatchRes.headers.get("ETag");

    expect(watchETag).toBeTruthy();
    expect(nonWatchETag).toBeTruthy();
    expect(watchETag).not.toBe(nonWatchETag);
    expect(watchETag).toContain("-live");
    expect(nonWatchETag).not.toContain("-live");
  });

  test("watch ETag in If-None-Match does not cache on non-watch handler", async () => {
    const watchHandler = createHandler(makeOpts(root, { watch: true }));
    const nonWatchHandler = createHandler(makeOpts(root, { watch: false }));

    const watchRes = await watchHandler(new Request("http://x/"));
    const watchETag = watchRes.headers.get("ETag");

    const nonWatchReqWithWatchTag = new Request("http://x/", {
      headers: { "If-None-Match": watchETag ?? "" },
    });
    const nonWatchRes = await nonWatchHandler(nonWatchReqWithWatchTag);

    expect(nonWatchRes.status).toBe(200);
  });
});
