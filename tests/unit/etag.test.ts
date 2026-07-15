import { describe, expect, test } from "bun:test";
import {
  isNotModified,
  makeEtag,
  notModified,
  notModifiedSince,
} from "../../src/handlers";

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

  test("If-None-Match matches anywhere in a comma-separated list", () => {
    const etag = makeEtag(10, 1000);
    expect(
      notModified(
        new Request("http://x", {
          headers: { "If-None-Match": `"other-1", ${etag}, "other-2"` },
        }),
        etag,
      ),
    ).toBe(true);
    expect(
      notModified(
        new Request("http://x", {
          headers: { "If-None-Match": '"other-1", "other-2"' },
        }),
        etag,
      ),
    ).toBe(false);
  });

  test("If-Modified-Since", () => {
    const mtimeMs = Date.parse("2024-01-01T00:00:00.000Z");
    expect(
      notModifiedSince(
        new Request("http://x", {
          headers: { "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" },
        }),
        mtimeMs,
      ),
    ).toBe(true);
    expect(
      notModifiedSince(
        new Request("http://x", {
          headers: { "If-Modified-Since": "Sun, 31 Dec 2023 00:00:00 GMT" },
        }),
        mtimeMs,
      ),
    ).toBe(false);
    expect(notModifiedSince(new Request("http://x"), mtimeMs)).toBe(false);
  });

  test("If-Modified-Since with an unparseable date is treated as absent", () => {
    const mtimeMs = Date.parse("2024-01-01T00:00:00.000Z");
    expect(
      notModifiedSince(
        new Request("http://x", {
          headers: { "If-Modified-Since": "not-a-date" },
        }),
        mtimeMs,
      ),
    ).toBe(false);
  });

  test("If-None-Match takes precedence over If-Modified-Since", () => {
    const mtimeMs = Date.parse("2024-01-01T00:00:00.000Z");
    const etag = makeEtag(10, mtimeMs);

    // If-Modified-Since alone is fresh enough for a 304.
    expect(
      isNotModified(
        new Request("http://x", {
          headers: { "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" },
        }),
        etag,
        mtimeMs,
      ),
    ).toBe(true);

    // A stale If-None-Match wins over a fresh If-Modified-Since.
    expect(
      isNotModified(
        new Request("http://x", {
          headers: {
            "If-None-Match": '"stale-etag"',
            "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT",
          },
        }),
        etag,
        mtimeMs,
      ),
    ).toBe(false);

    // A matching If-None-Match wins over a stale If-Modified-Since.
    expect(
      isNotModified(
        new Request("http://x", {
          headers: {
            "If-None-Match": etag,
            "If-Modified-Since": "Sun, 31 Dec 2023 00:00:00 GMT",
          },
        }),
        etag,
        mtimeMs,
      ),
    ).toBe(true);
  });
});
