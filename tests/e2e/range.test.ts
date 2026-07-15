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
});
