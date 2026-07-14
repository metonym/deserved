import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e watch / live reload", () => {
  test("live-reload paths 404 quietly when --watch is off", async () => {
    const root = fixtureDir("watch-off");
    write(root, "index.html", "<!doctype html><h1>v1</h1>");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const live = await fetch(`${cli.base}/__live.js`);
      expect(live.status).toBe(404);

      const events = await fetch(`${cli.base}/__events`);
      expect(events.status).toBe(404);

      const html = await fetch(`${cli.base}/`);
      expect(await html.text()).not.toContain("/__live.js");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test(
    "injects live script, serves SSE, and reloads on change",
    async () => {
      const root = fixtureDir("watch");
      write(
        root,
        "index.html",
        "<!doctype html><html><body><h1>v1</h1></body></html>",
      );

      const cli = await startCli(root, ["--watch", "--no-compress"]);
      try {
        const html = await fetch(`${cli.base}/`);
        const body = await html.text();
        expect(body).toContain("/__live.js");
        expect(body).toContain("<h1>v1</h1>");

        const live = await fetch(`${cli.base}/__live.js`);
        expect(live.status).toBe(200);
        expect(await live.text()).toContain("EventSource");

        const res = await fetch(`${cli.base}/__events`);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/event-stream");

        expect(res.body).toBeTruthy();
        if (!res.body) throw new Error("expected SSE body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        buf = await readUntil(
          reader,
          decoder,
          buf,
          (s) => s.includes(": connected"),
          2000,
        );
        expect(buf).toContain(": connected");

        // Keep poking the tree until the watcher fires (fs.watch can be slow/flaky)
        const deadline = Date.now() + 6000;
        let n = 0;
        while (!buf.includes("data: reload") && Date.now() < deadline) {
          n++;
          write(
            root,
            "index.html",
            `<!doctype html><html><body><h1>v${n}</h1></body></html>`,
          );
          write(root, `touch-${n}.txt`, String(Date.now()));
          buf = await readUntil(
            reader,
            decoder,
            buf,
            (s) => s.includes("data: reload"),
            400,
          );
        }

        expect(buf).toContain("data: reload");
        await reader.cancel().catch(() => {});
      } finally {
        cli.stop();
        removeFixture(root);
      }
    },
    { timeout: 20_000 },
  );
});

async function readUntil(
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> },
  decoder: TextDecoder,
  buf: string,
  pred: (s: string) => boolean,
  ms: number,
): Promise<string> {
  const deadline = Date.now() + ms;
  while (!pred(buf)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => null),
    ]);

    if (!chunk) break;
    if (chunk.done || !chunk.value) break;
    buf += decoder.decode(chunk.value, { stream: true });
  }
  return buf;
}
