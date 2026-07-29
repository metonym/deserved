import { describe, expect, test } from "bun:test";
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

function expectCorsHeaders(res: Response) {
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Headers")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
    "GET, HEAD, OPTIONS",
  );
}

describe("cors", () => {
  test("GET on a file: 200 with all CORS headers and an intact body", async () => {
    const root = mkdtempSync(join(tmpdir(), "cors-get-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      const handle = createHandler(makeOpts(root, { cors: true }));

      const res = await handle(new Request("http://x/"));
      expect(res.status).toBe(200);
      expectCorsHeaders(res);
      expect(await res.text()).toBe("<h1>hi</h1>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("404 response carries CORS headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "cors-404-"));
    try {
      const handle = createHandler(makeOpts(root, { cors: true }));
      const res = await handle(new Request("http://x/nope"));
      expect(res.status).toBe(404);
      expectCorsHeaders(res);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("304 response carries CORS headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "cors-304-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      const handle = createHandler(makeOpts(root, { cors: true }));

      const first = await handle(new Request("http://x/"));
      const etag = first.headers.get("ETag");
      expect(etag).toBeTruthy();

      const second = await handle(
        new Request("http://x/", {
          headers: { "If-None-Match": etag ?? "" },
        }),
      );
      expect(second.status).toBe(304);
      expectCorsHeaders(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("HEAD", () => {
  test("HEAD on a cold compressible html file: 200, empty body, correct headers; a later GET still returns the full body", async () => {
    const root = mkdtempSync(join(tmpdir(), "head-compress-"));
    try {
      const body = `<h1>${"x".repeat(2000)}</h1>`;
      writeFileSync(join(root, "index.html"), body);
      const handle = createHandler(makeOpts(root, { compress: true }));

      const headRes = await handle(
        new Request("http://x/", {
          method: "HEAD",
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("Content-Encoding")).toBeNull();
      expect(headRes.headers.get("Content-Length")).toBe(
        String(Buffer.byteLength(body)),
      );
      expect(headRes.headers.get("ETag")).toBeTruthy();
      const headBytes = await headRes.arrayBuffer();
      expect(headBytes.byteLength).toBe(0);

      const getRes = await handle(
        new Request("http://x/", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Content-Encoding")).toBe("gzip");
      const decoded = new TextDecoder().decode(
        Bun.gunzipSync(new Uint8Array(await getRes.arrayBuffer())),
      );
      expect(decoded).toBe(body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HEAD with a matching If-None-Match returns 304", async () => {
    const root = mkdtempSync(join(tmpdir(), "head-304-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      const handle = createHandler(makeOpts(root));

      const getRes = await handle(new Request("http://x/"));
      const etag = getRes.headers.get("ETag");
      expect(etag).toBeTruthy();

      const headRes = await handle(
        new Request("http://x/", {
          method: "HEAD",
          headers: { "If-None-Match": etag ?? "" },
        }),
      );
      expect(headRes.status).toBe(304);
      const bytes = await headRes.arrayBuffer();
      expect(bytes.byteLength).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
