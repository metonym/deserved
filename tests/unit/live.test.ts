import { describe, expect, spyOn, test } from "bun:test";
import {
  injectLiveReload,
  LIVE_PATH,
  LIVE_SCRIPT,
  logRequest,
} from "../../src/server";

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

describe("LIVE_SCRIPT", () => {
  test("hot-swaps stylesheets on a css message instead of reloading", () => {
    expect(LIVE_SCRIPT).toContain('m.data==="css"');
    expect(LIVE_SCRIPT).toContain(
      "querySelectorAll('link[rel=\"stylesheet\"]')",
    );
  });

  test("falls back to a full reload for any non-css message", () => {
    expect(LIVE_SCRIPT).toContain("location.reload()");
  });

  test("keeps the onerror reconnect-then-reload behavior", () => {
    expect(LIVE_SCRIPT).toContain(
      "e.onerror=()=>{e.close();setTimeout(()=>location.reload(),1000)}",
    );
  });
});

describe("logRequest", () => {
  test("strips control characters from the path so terminal escapes can't be injected", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      logRequest("GET", 404, "/\x1b[31mFAKE-ERROR\x1b[0m", false);
      const line = logSpy.mock.calls[0]?.[0] as string;
      expect(line).not.toContain("\x1b[31mFAKE-ERROR");
      expect(line).toContain("/[31mFAKE-ERROR[0m");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("logs normal paths unchanged", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      logRequest("GET", 200, "/index.html", false);
      const line = logSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain("/index.html");
    } finally {
      logSpy.mockRestore();
    }
  });
});
