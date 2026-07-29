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

describe("Range requests", () => {
  const root = mkdtempSync(join(tmpdir(), "range-"));
  const content = "0123456789";
  writeFileSync(join(root, "file.txt"), content);
  const handle = createHandler(makeOpts(root));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("normal range returns 206 with correct body/headers", async () => {
    const res = await handle(
      new Request("http://x/file.txt", { headers: { Range: "bytes=0-4" } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/10");
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(await res.text()).toBe("01234");
  });

  test("suffix range returns the last N bytes", async () => {
    const res = await handle(
      new Request("http://x/file.txt", { headers: { Range: "bytes=-5" } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 5-9/10");
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(await res.text()).toBe("56789");
  });

  test("open-ended range returns through end of file", async () => {
    const res = await handle(
      new Request("http://x/file.txt", { headers: { Range: "bytes=2-" } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-9/10");
    expect(res.headers.get("Content-Length")).toBe("8");
    expect(await res.text()).toBe("23456789");
  });

  test("out-of-bounds range returns 416", async () => {
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { Range: "bytes=100-200" },
      }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
  });

  test("HEAD request with Range keeps a null body", async () => {
    const res = await handle(
      new Request("http://x/file.txt", {
        method: "HEAD",
        headers: { Range: "bytes=0-4" },
      }),
    );
    expect(res.body).toBeNull();
  });
});

describe("If-Range", () => {
  const root = mkdtempSync(join(tmpdir(), "if-range-"));
  const content = "0123456789";
  writeFileSync(join(root, "file.txt"), content);
  const handle = createHandler(makeOpts(root));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function currentValidators() {
    const res = await handle(new Request("http://x/file.txt"));
    return {
      etag: res.headers.get("ETag") ?? "",
      lastModified: res.headers.get("Last-Modified") ?? "",
    };
  }

  test("matching strong etag honors the Range", async () => {
    const { etag } = await currentValidators();
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { Range: "bytes=0-4", "If-Range": etag },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/10");
  });

  test("stale etag falls back to a full 200", async () => {
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { Range: "bytes=0-4", "If-Range": '"stale-etag"' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(await res.text()).toBe(content);
  });

  test("weak validator never matches", async () => {
    const { etag } = await currentValidators();
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { Range: "bytes=0-4", "If-Range": `W/${etag}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
  });

  test("matching Last-Modified date honors the Range", async () => {
    const { lastModified } = await currentValidators();
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: { Range: "bytes=0-4", "If-Range": lastModified },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/10");
  });

  test("older date falls back to a full 200", async () => {
    const res = await handle(
      new Request("http://x/file.txt", {
        headers: {
          Range: "bytes=0-4",
          "If-Range": "Mon, 01 Jan 2001 00:00:00 GMT",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
  });
});
