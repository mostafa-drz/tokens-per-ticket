import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const repo = path.resolve(import.meta.dirname, "../..");
const hook = path.join(repo, ".claude/hooks/ticket-guard.mjs");

type HookOutput = {
  hookSpecificOutput: { additionalContext: string; sessionTitle?: string };
  systemMessage?: string;
};

function runHook(projectDir: string, env: Record<string, string> = {}): HookOutput {
  const stdout = execFileSync("node", [hook], {
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: projectDir }),
    env: {
      ...process.env,
      ANTHROPIC_CUSTOM_HEADERS: "",
      CLAUDE_PROJECT_DIR: projectDir,
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      ...env,
    },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

/** A product repo on npm that adopted the tooling, on a ticket branch. */
function productRepo(dir: string, { withLib }: { withLib: boolean }): string {
  const root = path.join(dir, withLib ? "with-lib" : "without-lib");
  mkdirSync(path.join(root, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "jane/eng-123-retry"], { cwd: root });
  copyFileSync(path.join(repo, "ticket-contract.yaml"), path.join(root, "ticket-contract.yaml"));
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "package-lock.json"), "{}");
  if (withLib) symlinkSync(path.join(repo, "src/lib"), path.join(root, "src/lib"));
  return root;
}

describe("ticket-guard hook in a product repo", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tpt-hook-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("suggests the repo's own package manager, with npm's -- separator", () => {
    const output = runHook(productRepo(dir, { withLib: true }));
    assert.equal(output.hookSpecificOutput.sessionTitle, "ENG-123");
    assert.equal(output.systemMessage, "Tokens in this session are not counted against ENG-123. Exit and run: npm run ticket:start -- ENG-123");
  });

  it("says what failed when the helpers aren't where the hook looks, instead of suggesting an install", () => {
    const output = runHook(productRepo(dir, { withLib: false }));
    assert.match(output.systemMessage ?? "", /could not load src\/lib\/contract\.ts/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /install/);
  });
});
