import { describe, expect, test } from "bun:test";
import {
  acceptsGzip,
  contentType,
  isCompressible,
  isHtml,
  pickEncoding,
} from "../../src/handlers";

describe("mime", () => {
  test("extension fallbacks", () => {
    const empty = { type: "" } as Bun.BunFile;
    expect(contentType(empty, "/x.html")).toContain("text/html");
    expect(contentType(empty, "/x.js")).toContain("javascript");
    expect(contentType(empty, "/x.unknown")).toBe("application/octet-stream");
    expect(contentType(empty, "/LICENSE")).toBe("application/octet-stream");
    expect(contentType(empty, "/.env")).toBe("application/octet-stream");
  });

  test("uses Bun.file type when present", () => {
    const file = { type: "image/png" } as Bun.BunFile;
    expect(contentType(file, "/x.png")).toBe("image/png");
  });

  test("compressible detection", () => {
    expect(isCompressible("text/css")).toBe(true);
    expect(isCompressible("application/json;charset=utf-8")).toBe(true);
    expect(isCompressible("image/png")).toBe(false);
  });

  test("isHtml", () => {
    expect(isHtml("text/html;charset=utf-8")).toBe(true);
    expect(isHtml("text/plain")).toBe(false);
  });

  test("acceptsGzip", () => {
    expect(
      acceptsGzip(
        new Request("http://x", { headers: { "Accept-Encoding": "gzip" } }),
      ),
    ).toBe(true);
    expect(
      acceptsGzip(
        new Request("http://x", {
          headers: { "Accept-Encoding": "gzip, deflate, br" },
        }),
      ),
    ).toBe(true);
    expect(
      acceptsGzip(
        new Request("http://x", { headers: { "Accept-Encoding": "br" } }),
      ),
    ).toBe(false);
    expect(acceptsGzip(new Request("http://x"))).toBe(false);
  });

  test("pickEncoding prefers zstd, falls back to gzip, else null", () => {
    expect(
      pickEncoding(
        new Request("http://x", {
          headers: { "Accept-Encoding": "gzip, zstd" },
        }),
      ),
    ).toBe("zstd");
    expect(
      pickEncoding(
        new Request("http://x", { headers: { "Accept-Encoding": "gzip" } }),
      ),
    ).toBe("gzip");
    expect(
      pickEncoding(
        new Request("http://x", { headers: { "Accept-Encoding": "br" } }),
      ),
    ).toBe(null);
    expect(pickEncoding(new Request("http://x"))).toBe(null);
  });
});
