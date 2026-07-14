import { describe, expect, test } from "bun:test";
import { fixtureDir, removeFixture, startCli, write } from "./helpers";

describe("e2e cors", () => {
  test("--cors sets ACAO and answers OPTIONS", async () => {
    const root = fixtureDir("cors");
    write(root, "index.html", "<!doctype html><h1>ok</h1>");

    const cli = await startCli(root, ["--cors", "--no-compress"]);
    try {
      const get = await fetch(`${cli.base}/`);
      expect(get.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const options = await fetch(`${cli.base}/`, { method: "OPTIONS" });
      expect(options.status).toBe(204);
      expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");
    } finally {
      cli.stop();
      removeFixture(root);
    }
  });
});
