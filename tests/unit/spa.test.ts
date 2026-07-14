import { describe, expect, test } from "bun:test";
import { acceptsHtml, shouldSpaFallback } from "../../src/handlers";

describe("acceptsHtml", () => {
  test("true for html or missing/* accept", () => {
    expect(
      acceptsHtml(
        new Request("http://x", { headers: { Accept: "text/html" } }),
      ),
    ).toBe(true);
    expect(
      acceptsHtml(new Request("http://x", { headers: { Accept: "*/*" } })),
    ).toBe(true);
    expect(acceptsHtml(new Request("http://x"))).toBe(true);
  });

  test("false when client only wants non-html", () => {
    expect(
      acceptsHtml(
        new Request("http://x", { headers: { Accept: "image/png" } }),
      ),
    ).toBe(false);
  });
});

describe("shouldSpaFallback", () => {
  test("rewrites routes without extensions", () => {
    expect(shouldSpaFallback("/about")).toBe(true);
    expect(shouldSpaFallback("/app/settings")).toBe(true);
  });

  test("leaves assets and live paths alone", () => {
    expect(shouldSpaFallback("/logo.png")).toBe(false);
    expect(shouldSpaFallback("/app.js")).toBe(false);
    expect(shouldSpaFallback("/favicon.ico")).toBe(false);
    expect(shouldSpaFallback("/__events")).toBe(false);
  });
});
