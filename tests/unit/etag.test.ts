import { describe, expect, test } from "bun:test";
import { makeEtag, notModified } from "../../src/handlers";

describe("etag", () => {
  test("format", () => {
    expect(makeEtag(10, 1000.9)).toBe('"10-1000"');
    expect(makeEtag(10, 1000.9, "-live")).toBe('"10-1000-live"');
  });

  test("If-None-Match", () => {
    const etag = makeEtag(10, 1000);
    expect(
      notModified(
        new Request("http://x", { headers: { "If-None-Match": etag } }),
        etag,
      ),
    ).toBe(true);
    expect(
      notModified(
        new Request("http://x", { headers: { "If-None-Match": `W/${etag}` } }),
        etag,
      ),
    ).toBe(true);
    expect(notModified(new Request("http://x"), etag)).toBe(false);
  });
});
