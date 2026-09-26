import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
import {
  createSseHub,
  DEFAULT_OPTIONS,
  EVENTS_PATH,
  flushLogs,
  injectLiveReload,
  LIVE_PATH,
  LIVE_SCRIPT,
  logRequest,
  shouldColor,
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

describe("events endpoint", () => {
  test("HEAD returns SSE headers without subscribing a client", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-head-"));
    const hub = createSseHub();
    const subscribe = mock(hub.subscribe);
    try {
      const handle = createHandler(
        { ...DEFAULT_OPTIONS, root, watch: true, quiet: true },
        { ...hub, subscribe },
      );
      const res = await handle(
        new Request(`http://x${EVENTS_PATH}`, { method: "HEAD" }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("logRequest", () => {
  // Request lines are batched and flushed to process.stdout once per tick
  // (see flushLogs); force that flush so the write is observable
  // synchronously here instead of on the next microtask.
  test("strips control characters from the path so terminal escapes can't be injected", () => {
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );
    try {
      logRequest("GET", 404, "/\x1b[31mFAKE-ERROR\x1b[0m", false);
      flushLogs();
      const line = writeSpy.mock.calls[0]?.[0] as string;
      expect(line).not.toContain("\x1b[31mFAKE-ERROR");
      expect(line).toContain("/[31mFAKE-ERROR[0m");
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("logs normal paths unchanged", () => {
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );
    try {
      logRequest("GET", 200, "/index.html", false);
      flushLogs();
      const line = writeSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain("/index.html");
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("shouldColor", () => {
  test("colors a TTY unless NO_COLOR is set", () => {
    expect(shouldColor(true, {})).toBe(true);
    expect(shouldColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(shouldColor(true, { NO_COLOR: "" })).toBe(true);
  });

  test("never colors piped output", () => {
    expect(shouldColor(false, {})).toBe(false);
    expect(shouldColor(undefined, {})).toBe(false);
  });
});
