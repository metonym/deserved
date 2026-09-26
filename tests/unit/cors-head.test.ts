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
  test("OPTIONS preflight: 204 with CORS headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "cors-options-"));
    try {
      const handle = createHandler(makeOpts(root, { cors: true }));
      const res = await handle(new Request("http://x/", { method: "OPTIONS" }));
      expect(res.status).toBe(204);
      expectCorsHeaders(res);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("OPTIONS without --cors: 405", async () => {
    const root = mkdtempSync(join(tmpdir(), "cors-options-off-"));
    try {
      const handle = createHandler(makeOpts(root));
      const res = await handle(new Request("http://x/", { method: "OPTIONS" }));
      expect(res.status).toBe(405);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
  test("HEAD on a cold compressible html file: 200, empty body, compressed headers; a later GET still returns the full body", async () => {
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
      expect(headRes.headers.get("Content-Encoding")).toBe("gzip");
      const headLength = Number(headRes.headers.get("Content-Length"));
      expect(headLength).toBeGreaterThan(0);
      expect(headLength).toBeLessThan(Buffer.byteLength(body));
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
      expect(getRes.headers.get("Content-Length")).toBe(String(headLength));
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

describe("HEAD matches GET", () => {
  async function both(opts: Options, path: string, headers = {}) {
    const handle = createHandler(opts);
    const get = await handle(new Request(`http://x${path}`, { headers }));
    const head = await handle(
      new Request(`http://x${path}`, { method: "HEAD", headers }),
    );
    return { get, head, body: await get.arrayBuffer() };
  }

  test("compressed file: same Content-Encoding and Content-Length", async () => {
    const root = mkdtempSync(join(tmpdir(), "head-gzip-"));
    try {
      writeFileSync(join(root, "app.js"), "console.log(1);\n".repeat(200));
      const { get, head, body } = await both(
        makeOpts(root, { compress: true }),
        "/app.js",
        { "Accept-Encoding": "gzip" },
      );
      expect(head.headers.get("Content-Encoding")).toBe("gzip");
      expect(head.headers.get("Content-Length")).toBe(
        get.headers.get("Content-Length"),
      );
      expect(head.headers.get("Content-Length")).toBe(String(body.byteLength));
      expect(await head.text()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--watch HTML: Content-Length includes the injected script", async () => {
    const root = mkdtempSync(join(tmpdir(), "head-live-"));
    try {
      writeFileSync(join(root, "index.html"), "<body>hi</body>");
      const { head, body } = await both(makeOpts(root, { watch: true }), "/");
      expect(head.headers.get("Content-Encoding")).toBeNull();
      expect(head.headers.get("Content-Length")).toBe(String(body.byteLength));
      expect(await head.text()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
