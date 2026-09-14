import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HOOK_SCRIPT, ensureCommitTrailerHook, runGitTrailer } from "../../src/cli/git-trailer.ts";
import { handleHook } from "../../src/cli/hook.ts";
import { mergeHookSettings } from "../../src/cli/init.ts";
import { loadContract } from "../../src/lib/contract.ts";
import type { SessionReport } from "../../src/lib/registry-client.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(path.join(os.tmpdir(), "tpt-hook-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A product repo that adopted tokens-per-ticket, on the given branch. */
function productRepo(branch: string): string {
  const root = path.join(dir, `repo-${n++}`);
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
  copyFileSync(path.join(repoRoot, "tokens-per-ticket.yaml"), path.join(root, "tokens-per-ticket.yaml"));
  return root;
}

const connected = { ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_AUTH_TOKEN: "sk-jane", TPT_REGISTRY_URL: "http://registry.test" };

function recorder(ok = true) {
  const reports: SessionReport[] = [];
  return {
    reports,
    deps: {
      stateDir: mkdtempSync(path.join(dir, "state-")),
      report: async (report: SessionReport) => {
        reports.push(report);
        return ok ? ({ ok: true } as const) : ({ ok: false, reason: "could not reach the registry" } as const);
      },
    },
  };
}

describe("session hook", () => {
  it("reports the ticket at session start, watches .git/HEAD, and names the session", async () => {
    const root = productRepo("jane/eng-123-retry");
    const { reports, deps } = recorder();
    const output = await handleHook({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: root }, connected, deps);

    assert.deepEqual(
      reports.map((r) => [r.session_id, r.ticket, r.branch, r.event]),
      [["s1", "ENG-123", "jane/eng-123-retry", "SessionStart"]],
    );
    assert.equal(output.hookSpecificOutput?.sessionTitle, "ENG-123");
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /count toward ticket ENG-123, following the current branch/);
    assert.equal(realpath(output.hookSpecificOutput?.watchPaths?.[0]), realpath(path.join(root, ".git", "HEAD")));
    assert.equal(output.systemMessage, undefined);
  });

  it("follows a branch switch through FileChanged and says so", async () => {
    const root = productRepo("jane/eng-123-retry");
    const { reports, deps } = recorder();
    await handleHook({ hook_event_name: "SessionStart", session_id: "s2", cwd: root }, connected, deps);
    execFileSync("git", ["-C", root, "switch", "-q", "-c", "jane/eng-124-next"]);
    const output = await handleHook({ hook_event_name: "FileChanged", session_id: "s2", cwd: root, file_path: path.join(root, ".git/HEAD") }, connected, deps);

    assert.deepEqual(reports.map((r) => r.ticket), ["ENG-123", "ENG-124"]);
    assert.match(output.systemMessage ?? "", /now counting toward ENG-124/);
    assert.ok(output.hookSpecificOutput?.watchPaths?.length);
  });

  it("reports before a prompt only when something changed", async () => {
    const root = productRepo("jane/eng-5-a");
    const { reports, deps } = recorder();
    await handleHook({ hook_event_name: "SessionStart", session_id: "s3", cwd: root }, connected, deps);
    assert.deepEqual(await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s3", cwd: root }, connected, deps), {});
    assert.equal(reports.length, 1);

    execFileSync("git", ["-C", root, "switch", "-q", "-c", "main"]);
    await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s3", cwd: root }, connected, deps);
    assert.deepEqual(reports.map((r) => r.ticket), ["ENG-5", null]);
  });

  it("keeps the user's own session title", async () => {
    const root = productRepo("jane/eng-8-x");
    const output = await handleHook({ hook_event_name: "SessionStart", session_id: "s4", cwd: root, session_title: "pairing" }, connected, recorder().deps);
    assert.equal(output.hookSpecificOutput?.sessionTitle, undefined);
  });

  it("warns once when the registry can't be reached, not on every prompt", async () => {
    const root = productRepo("jane/eng-9-x");
    const { deps } = recorder(false);
    const start = await handleHook({ hook_event_name: "SessionStart", session_id: "s5", cwd: root }, connected, deps);
    assert.match(start.systemMessage ?? "", /Couldn't report this session/);
    assert.deepEqual(await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s5", cwd: root }, connected, deps), {});
  });

  it("explains what's missing when Claude Code isn't connected to the gateway", async () => {
    const root = productRepo("jane/eng-10-x");
    const { reports, deps } = recorder();
    const noGateway = await handleHook({ hook_event_name: "SessionStart", session_id: "s6", cwd: root }, {}, deps);
    assert.match(noGateway.systemMessage ?? "", /ANTHROPIC_BASE_URL is not set/);
    const noKey = await handleHook({ hook_event_name: "SessionStart", session_id: "s7", cwd: root }, { ANTHROPIC_BASE_URL: "http://gw" }, deps);
    assert.match(noKey.systemMessage ?? "", /No gateway key/);
    assert.equal(reports.length, 0);
  });

  it("points out a session started for a different ticket than the branch", async () => {
    const root = productRepo("jane/eng-11-x");
    const output = await handleHook(
      { hook_event_name: "SessionStart", session_id: "s8", cwd: root },
      { ...connected, ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: ticket:ENG-7" },
      recorder().deps,
    );
    assert.match(output.systemMessage ?? "", /started with ticket ENG-7/);
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /ticket ENG-7\./);
  });

  it("stays silent in a repo that hasn't adopted tokens-per-ticket", async () => {
    const root = path.join(dir, "plain");
    execFileSync("git", ["init", "-q", root]);
    const { reports, deps } = recorder();
    assert.deepEqual(await handleHook({ hook_event_name: "SessionStart", session_id: "s9", cwd: root }, connected, deps), {});
    assert.equal(reports.length, 0);
  });
});

describe("commit trailer", () => {
  it("adds the ticket trailer once on a ticket branch, and nothing elsewhere", () => {
    const root = productRepo("jane/eng-42-login");
    const message = path.join(root, "MSG");
    writeFileSync(message, "feat: login\n");
    runGitTrailer([message, "message"], root);
    runGitTrailer([message, "message"], root);
    assert.equal(readFileSync(message, "utf8"), "feat: login\n\nTicket: ENG-42\n");

    execFileSync("git", ["-C", root, "switch", "-q", "-c", "main"]);
    writeFileSync(message, "chore: bump\n");
    runGitTrailer([message, "message"], root);
    assert.equal(readFileSync(message, "utf8"), "chore: bump\n");
  });

  it("leaves merge messages alone", () => {
    const root = productRepo("jane/eng-43-x");
    const message = path.join(root, "MSG");
    writeFileSync(message, "Merge branch 'main'\n");
    runGitTrailer([message, "merge"], root);
    assert.equal(readFileSync(message, "utf8"), "Merge branch 'main'\n");
  });

  it("installs the git hook, and never overwrites someone else's", () => {
    const root = productRepo("jane/eng-44-x");
    const contract = loadContract(root);
    assert.equal(ensureCommitTrailerHook(root, contract), "installed");
    const hook = path.join(root, ".git/hooks/prepare-commit-msg");
    assert.equal(readFileSync(hook, "utf8"), HOOK_SCRIPT);
    assert.ok(statSync(hook).mode & 0o100);
    assert.equal(ensureCommitTrailerHook(root, contract), "present");

    writeFileSync(hook, "#!/bin/sh\nnpx husky-thing\n");
    assert.equal(ensureCommitTrailerHook(root, contract), "foreign");
    assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\nnpx husky-thing\n");
  });
});

describe("init settings merge", () => {
  it("adds the hooks and permissions without dropping what the repo has, and only once", () => {
    const settings = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { SessionStart: [{ hooks: [{ command: "./team-hook.sh" }] }] },
    };
    const first = mergeHookSettings(settings);
    assert.ok(first.includes("SessionStart hook"));
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "./team-hook.sh");
    assert.ok(settings.permissions.allow.includes("Bash(npm test)"));
    assert.deepEqual(mergeHookSettings(settings), []);
  });
});

function realpath(file: string | undefined): string {
  return file ? execFileSync("realpath", [file], { encoding: "utf8" }).trim() : "";
}
