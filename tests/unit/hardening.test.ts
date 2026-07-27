import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
import type { Options } from "../../src/server";
import { formatUrl } from "../../src/server";

function makeOpts(root: string, overrides: Partial<Options> = {}): Options {
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
