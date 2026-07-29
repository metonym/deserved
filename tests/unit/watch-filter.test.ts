import { describe, expect, test } from "bun:test";
import { classifyBatch, isIgnoredWatchPath } from "../../src/server";

describe("isIgnoredWatchPath", () => {
  test("ignores nested .git churn", () => {
    expect(isIgnoredWatchPath("sub/.git/index")).toBe(true);
  });

  test("ignores top-level dotfiles", () => {
    expect(isIgnoredWatchPath(".hidden")).toBe(true);
  });

  test("ignores nested node_modules", () => {
    expect(isIgnoredWatchPath("sub/node_modules/x")).toBe(true);
  });

  test("keeps ordinary nested files", () => {
    expect(isIgnoredWatchPath("sub/app.css")).toBe(false);
  });

  test("ignores backslash-separated nested .git churn", () => {
    expect(isIgnoredWatchPath("windows\\sub\\.git\\x")).toBe(true);
  });
});

describe("classifyBatch", () => {
  test("classifies an all-css batch as css", () => {
    expect(classifyBatch(["style.css"])).toBe("css");
    expect(classifyBatch(["a.css", "sub/b.css"])).toBe("css");
  });

  test("classifies a mixed batch as reload", () => {
    expect(classifyBatch(["style.css", "index.html"])).toBe("reload");
  });

  test("classifies a non-css batch as reload", () => {
    expect(classifyBatch(["index.html"])).toBe("reload");
  });

  test("treats a null filename as non-css", () => {
    expect(classifyBatch([null])).toBe("reload");
    expect(classifyBatch(["style.css", null])).toBe("reload");
  });

  test("treats an empty batch as reload", () => {
    expect(classifyBatch([])).toBe("reload");
  });
});
