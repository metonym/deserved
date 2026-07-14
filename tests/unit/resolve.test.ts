import { describe, expect, test } from "bun:test";
import { buildCandidates, safeJoin } from "../../src/handlers";

describe("buildCandidates", () => {
  test("root becomes index.html", () => {
    expect(buildCandidates("")).toEqual(["index.html"]);
    expect(buildCandidates(".")).toEqual(["index.html"]);
  });

  test("bare path tries file, .html, then index", () => {
    expect(buildCandidates("about")).toEqual([
      "about",
      "about.html",
      "about/index.html",
    ]);
  });

  test("trailing slash only tries directory index", () => {
    expect(buildCandidates("about/")).toEqual(["about/index.html"]);
  });
});

describe("safeJoin", () => {
  test("blocks path traversal", () => {
    expect(safeJoin("/tmp/site", "../etc/passwd")).toBeNull();
    expect(safeJoin("/tmp/site", "ok/../../etc/passwd")).toBeNull();
  });

  test("keeps paths under root", () => {
    const joined = safeJoin("/tmp/site", "css/app.css");
    expect(joined).toBeTruthy();
    expect(joined?.endsWith("css/app.css")).toBe(true);
  });
});
