import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../../src/handlers";
import {
  createSseHub,
  EVENTS_PATH,
  injectLiveReload,
  LIVE_PATH,
  LIVE_SCRIPT,
} from "../../src/live";
import { flushLogs, logRequest, shouldColor } from "../../src/log";
import { DEFAULT_OPTIONS } from "../../src/options";

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
  const OPEN = 1;
  const CONNECTING = 0;
  const CLOSED = 2;

  // Runs the client script against stand-ins for the browser globals it
  // touches, exposing the EventSource it creates.
  function run() {
    const reload = mock(() => {});
    const link = { href: "http://x/style.css?t=1" };
    class FakeEventSource {
      static last: FakeEventSource;
      readyState = CONNECTING;
      onopen = () => {};
      onmessage = (_m: { data: string }) => {};
      onerror = () => {};
      constructor(readonly url: string) {
        FakeEventSource.last = this;
      }
      open() {
        this.readyState = OPEN;
        this.onopen();
      }
      error(state: number) {
        this.readyState = state;
        this.onerror();
      }
    }
    new Function("EventSource", "location", "document", LIVE_SCRIPT)(
      FakeEventSource,
      { reload },
      { querySelectorAll: () => [link] },
    );
    return { source: FakeEventSource.last, reload, link };
  }

  test("subscribes to the events endpoint without reloading", () => {
    const { source, reload } = run();
    expect(source.url).toBe(EVENTS_PATH);
    source.open();
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads on a reload message", () => {
    const { source, reload } = run();
    source.open();
    source.onmessage({ data: "reload" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("hot-swaps stylesheets on a css message instead of reloading", () => {
    const { source, reload, link } = run();
    source.open();
    source.onmessage({ data: "css" });
    expect(reload).not.toHaveBeenCalled();
    expect(link.href).toMatch(/^http:\/\/x\/style\.css\?t=\d+$/);
    expect(link.href).not.toBe("http://x/style.css?t=1");
  });

  test("waits out a restart, then reloads once the server is back", () => {
    const { source, reload } = run();
    source.open();
    source.error(CONNECTING);
    source.error(CONNECTING);
    expect(reload).not.toHaveBeenCalled();
    source.open();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("reloads if the server comes back without --watch", () => {
    const { source, reload } = run();
    source.open();
    source.error(CONNECTING);
    source.error(CLOSED);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("never reloads when the endpoint was never there", () => {
    const { source, reload } = run();
    source.error(CLOSED);
    expect(reload).not.toHaveBeenCalled();
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
