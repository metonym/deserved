export const LIVE_PATH = "/__live.js";
export const EVENTS_PATH = "/__events";

// Once the stream drops (server stopped or restarting), the browser's
// EventSource retries on its own; the first successful reconnect reloads
// the page. If the server comes back without --watch, /__events 404s and
// the source closes for good, so reload once to pick up the new server.
// A source that never connected (a handler with no hub) stays put, so
// it can't loop.
export const LIVE_SCRIPT = `(()=>{let down=false;const e=new EventSource("${EVENTS_PATH}");e.onopen=()=>{if(down)location.reload()};e.onmessage=(m)=>{if(m.data==="css"){for(const l of document.querySelectorAll('link[rel="stylesheet"]')){const h=l.href.split("?")[0];l.href=h+"?t="+Date.now()}}else{location.reload()}};e.onerror=()=>{if(down&&e.readyState===2)location.reload();down=true}})()`;

const INJECT = `<script src="${LIVE_PATH}"></script>`;

export function injectLiveReload(html: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + INJECT;
  return html.slice(0, idx) + INJECT + html.slice(idx);
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export function createSseHub() {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const PING = encoder.encode(": ping\n\n");

  // Bun force-closes a connection after ~10s of no traffic, which would
  // otherwise drop an idle browser tab's SSE stream and make it reload on
  // reconnect. Keep it warm so it only ever closes on shutdown.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      try {
        c.enqueue(PING);
      } catch {
        clients.delete(c);
      }
    }
  }, 8000);
  heartbeat.unref();

  function subscribe(): Response {
    let controller: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        clients.add(c);
        // retry: how soon the browser reconnects after a restart.
        c.enqueue(encoder.encode("retry: 500\n: connected\n\n"));
      },
      cancel() {
        clients.delete(controller);
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  function broadcast(data = "reload") {
    const payload = encoder.encode(`data: ${data}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(payload);
      } catch {
        clients.delete(c);
      }
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const c of clients) {
      try {
        c.close();
      } catch {}
    }
    clients.clear();
  }

  return { subscribe, broadcast, close };
}

export type Hub = ReturnType<typeof createSseHub>;

export function isIgnoredWatchPath(filename: string): boolean {
  return filename
    .split(/[/\\]/)
    .some((segment) => segment.startsWith(".") || segment === "node_modules");
}

export function classifyBatch(files: (string | null)[]): "css" | "reload" {
  if (files.length === 0) return "reload";
  return files.every((f) => f?.endsWith(".css")) ? "css" : "reload";
}
