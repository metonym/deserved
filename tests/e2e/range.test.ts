import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e range requests", () => {
  test("supports suffix and open-ended ranges", async () => {
    const root = fixtureDir("range");
    write(root, "data.bin", "0123456789");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const suffix = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=-3" },
      });
      expect(suffix.status).toBe(206);
      expect(await suffix.text()).toBe("789");
      expect(suffix.headers.get("Content-Range")).toBe("bytes 7-9/10");

      const openEnded = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=7-" },
      });
      expect(openEnded.status).toBe(206);
      expect(await openEnded.text()).toBe("789");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("responds 416 for out-of-bounds or inverted ranges", async () => {
    const root = fixtureDir("range-invalid");
    write(root, "data.bin", "0123456789");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const beyondEof = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=100-200" },
      });
      expect(beyondEof.status).toBe(416);
      expect(beyondEof.headers.get("Content-Range")).toBe("bytes */10");

      const inverted = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=5-2" },
      });
      expect(inverted.status).toBe(416);

      const zeroSuffix = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=-0" },
      });
      expect(zeroSuffix.status).toBe(416);
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("falls back to a normal 200 for a Range header that isn't 'bytes=...'", async () => {
    const root = fixtureDir("range-unparseable");
    write(root, "data.bin", "0123456789");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const res = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "not-a-range" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("0123456789");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("falls back to a normal 200 for a multi-range request", async () => {
    const root = fixtureDir("range-multi");
    write(root, "data.bin", "0123456789");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const res = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=0-1,2-3" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("0123456789");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  // Bun.serve slices a Bun.file body by the request's Range on its own, so
  // the full-body fallback is only safe if Bun also honors If-Range there
  // (it didn't before 1.4.3).
  test("serves the full file when If-Range doesn't match", async () => {
    const root = fixtureDir("range-if-range");
    write(root, "data.bin", "0123456789");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const etag = (await fetch(`${cli.base}/data.bin`)).headers.get("ETag");
      expect(etag).toBeTruthy();

      const matching = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=0-2", "If-Range": etag ?? "" },
      });
      expect(matching.status).toBe(206);
      expect(await matching.text()).toBe("012");

      for (const ifRange of ['"stale"', `W/${etag}`]) {
        const res = await fetch(`${cli.base}/data.bin`, {
          headers: { Range: "bytes=0-2", "If-Range": ifRange },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Range")).toBeNull();
        expect(await res.text()).toBe("0123456789");
      }
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });

  test("an aborted range read doesn't corrupt a later range on the same file", async () => {
    const root = fixtureDir("range-abort");
    write(root, "data.bin", "0123456789");

    const cli = await startCli(root, ["--no-compress"]);
    try {
      const aborted = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=0-2" },
      });
      expect(aborted.status).toBe(206);
      await aborted.body?.cancel();

      const after = await fetch(`${cli.base}/data.bin`, {
        headers: { Range: "bytes=7-9" },
      });
      expect(after.status).toBe(206);
      expect(after.headers.get("Content-Length")).toBe("3");
      expect(await after.text()).toBe("789");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
