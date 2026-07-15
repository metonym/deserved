import { describe, expect, test } from "bun:test";
import { contentType, isCompressible, isHtml } from "../../src/handlers";

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
});
