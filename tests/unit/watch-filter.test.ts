import { describe, expect, test } from "bun:test";
import { isIgnoredWatchPath } from "../../src/server";

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
