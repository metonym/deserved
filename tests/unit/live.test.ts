import { describe, expect, test } from "bun:test";
import { injectLiveReload, LIVE_PATH } from "../../src/server";

describe("injectLiveReload", () => {
  test("injects before </body>", () => {
    const out = injectLiveReload("<html><body><h1>x</h1></body></html>");
    expect(out).toContain(`<script src="${LIVE_PATH}"></script></body>`);
  });

  test("appends when there is no body tag", () => {
    const out = injectLiveReload("<h1>x</h1>");
    expect(out.endsWith(`<script src="${LIVE_PATH}"></script>`)).toBe(true);
  });
});
