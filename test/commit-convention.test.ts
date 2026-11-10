import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript script, no declaration file
import { checkHeader } from "../scripts/commit-convention.mjs";

const check = checkHeader as (message: string) => string[];

describe("commit convention", () => {
  it.each([
    "feat: support Oh My Pi",
    "fix(login): honour slow_down",
    "feat!: drop Node 20",
    "build(deps): bump vitest from 5.1.0 to 5.2.0",
    "ci: pin actions\n\nBody lines are free.",
  ])("accepts %j", (message) => {
    expect(check(message)).toEqual([]);
  });

  it.each([
    ["Support Oh My Pi", /type\(scope\)!: subject/],
    ["feature: x", /type\(scope\)!: subject/],
    ["feat:missing space", /type\(scope\)!: subject/],
    ["feat(Login): x", /type\(scope\)!: subject/],
    ["fix: trailing period.", /period/],
    [`feat: ${"x".repeat(100)}`, /at most 100/],
  ])("rejects %j", (message, problem) => {
    expect(check(message).join(" ")).toMatch(problem);
  });

  it("works as a commit-msg hook: comments ignored, git's own messages allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
    const run = (text: string) => {
      const file = join(dir, "MSG");
      writeFileSync(file, text);
      try {
        execFileSync("node", ["scripts/commit-convention.mjs", "--file", file], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
    expect(run("# Please enter the commit message\nfeat: x\n")).toBe(true);
    expect(run("Merge branch 'main' into topic\n")).toBe(true);
    expect(run("Update things\n")).toBe(false);
  });
});
