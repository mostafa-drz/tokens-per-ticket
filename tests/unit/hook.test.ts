import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HOOK_SCRIPT, ensureCommitTrailerHook, refreshTrustedCli, runGitTrailer, trustedCliPath } from "../../src/cli/git-trailer.ts";
import { HOOK_COMMAND, handleHook } from "../../src/cli/hook.ts";
import { mergeHookSettings } from "../../src/cli/init.ts";
import { loadContract } from "../../src/lib/contract.ts";
import { keyFingerprint, trustedRegistryUrl, type SessionReport } from "../../src/lib/registry-client.ts";

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
    // The key itself never goes to the registry, only its fingerprint.
    assert.equal(reports[0].key_fingerprint, keyFingerprint("sk-jane"));
    assert.ok(!JSON.stringify(reports[0]).includes("sk-jane"));
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
    const noKey = await handleHook({ hook_event_name: "SessionStart", session_id: "s7", cwd: root }, { ANTHROPIC_BASE_URL: "http://localhost:4000" }, deps);
    assert.match(noKey.systemMessage ?? "", /No gateway key/);
    assert.equal(reports.length, 0);
  });

  it("warns that a leftover ticket header will be refused when the registry is on", async () => {
    const root = productRepo("jane/eng-11-x");
    const output = await handleHook(
      { hook_event_name: "SessionStart", session_id: "s8", cwd: root },
      { ...connected, ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: ticket:ENG-7" },
      recorder().deps,
    );
    assert.match(output.systemMessage ?? "", /will refuse these calls/);
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /count toward ticket ENG-11, following the current branch/);
  });

  it("without a registry, points out a session started for a different ticket than the branch", async () => {
    const root = productRepo("jane/eng-12-x");
    writeFileSync(path.join(root, "tokens-per-ticket.yaml"), readFileSync(path.join(root, "tokens-per-ticket.yaml"), "utf8").replace("sessions: true", "sessions: false"));
    const output = await handleHook(
      { hook_event_name: "SessionStart", session_id: "s8b", cwd: root },
      { ...connected, ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: ticket:ENG-7" },
      recorder().deps,
    );
    assert.match(output.systemMessage ?? "", /started with ticket ENG-7/);
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /ticket ENG-7\./);
  });

  it("reports a subagent's worktree for that subagent only, without renaming the session", async () => {
    const root = productRepo("jane/eng-13-main");
    const worktree = path.join(dir, `wt-${n++}`);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "jane/eng-14-side", worktree]);
    copyFileSync(path.join(root, "tokens-per-ticket.yaml"), path.join(worktree, "tokens-per-ticket.yaml"));
    const { reports, deps } = recorder();

    await handleHook({ hook_event_name: "SessionStart", session_id: "s-sub", cwd: root }, connected, deps);
    const output = await handleHook({ hook_event_name: "CwdChanged", session_id: "s-sub", agent_id: "agent-1", cwd: root, new_cwd: worktree }, connected, deps);

    assert.deepEqual(
      reports.map((r) => [r.agent_id ?? "(main)", r.ticket]),
      [["(main)", "ENG-13"], ["agent-1", "ENG-14"]],
    );
    assert.equal(output.hookSpecificOutput?.sessionTitle, undefined);
  });

  it("stays silent in a repo that hasn't adopted tokens-per-ticket", async () => {
    const root = path.join(dir, "plain");
    execFileSync("git", ["init", "-q", root]);
    const { reports, deps } = recorder();
    assert.deepEqual(await handleHook({ hook_event_name: "SessionStart", session_id: "s9", cwd: root }, connected, deps), {});
    assert.equal(reports.length, 0);
  });
});

describe("registry URL trust", () => {
  it("prefers TPT_REGISTRY_URL from the user's or org's settings", () => {
    assert.deepEqual(trustedRegistryUrl({ envUrl: "https://tpt.corp.dev", repoUrl: "https://evil.example", gatewayUrl: "https://gw.corp.dev" }), {
      url: "https://tpt.corp.dev",
    });
  });

  it("uses the repo's registry_url only on the gateway's host", () => {
    assert.equal(trustedRegistryUrl({ repoUrl: "http://localhost:4100", gatewayUrl: "http://localhost:4000" }).url, "http://localhost:4100");
    assert.deepEqual(trustedRegistryUrl({ repoUrl: "https://evil.example/collect", gatewayUrl: "https://gw.corp.dev" }), {
      url: null,
      ignored: "https://evil.example/collect",
    });
    assert.equal(trustedRegistryUrl({ repoUrl: "http://localhost:4100" }).url, null);
  });

  it("doesn't report to a registry a branch pointed elsewhere, and says why", async () => {
    const root = productRepo("jane/eng-50-x");
    writeFileSync(
      path.join(root, "tokens-per-ticket.yaml"),
      readFileSync(path.join(root, "tokens-per-ticket.yaml"), "utf8").replace('registry_url: "http://localhost:4100"', 'registry_url: "https://evil.example"'),
    );
    const { reports, deps } = recorder();
    const output = await handleHook(
      { hook_event_name: "SessionStart", session_id: "s-evil", cwd: root },
      { ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_AUTH_TOKEN: "sk-jane" },
      deps,
    );
    assert.equal(reports.length, 0);
    assert.match(output.systemMessage ?? "", /isn't on the gateway's host, so it's ignored/);
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

  it("runs a copy of the CLI from the git directory, which a branch checkout can't change", () => {
    const root = productRepo("jane/eng-45-x");
    mkdirSync(path.join(root, ".tokens-per-ticket"), { recursive: true });
    writeFileSync(path.join(root, ".tokens-per-ticket/tpt.mjs"), "// trusted build\n");
    assert.equal(refreshTrustedCli(root, { replace: false }), "updated");
    const copy = trustedCliPath(root) ?? "";
    assert.equal(realpath(path.dirname(path.dirname(copy))), realpath(path.join(root, ".git")));
    assert.equal(readFileSync(copy, "utf8"), "// trusted build\n");
    assert.equal(refreshTrustedCli(root, { replace: false }), "current");

    // A branch swaps the checkout's bundle: hooks neither copy nor run it.
    writeFileSync(path.join(root, ".tokens-per-ticket/tpt.mjs"), "// from an untrusted branch\n");
    assert.equal(refreshTrustedCli(root, { replace: false }), "differs");
    assert.equal(readFileSync(copy, "utf8"), "// trusted build\n");
    assert.match(HOOK_SCRIPT, /--git-common-dir/);
    assert.doesNotMatch(HOOK_SCRIPT, /show-toplevel/);

    // Only an explicit init switches to the checkout's CLI.
    assert.equal(refreshTrustedCli(root, { replace: true }), "updated");
    assert.equal(readFileSync(copy, "utf8"), "// from an untrusted branch\n");
  });

  it("Claude Code hooks run the trusted copy, falling back to the checkout only before one exists", () => {
    const root = productRepo("jane/eng-46-x");
    mkdirSync(path.join(root, ".tokens-per-ticket"), { recursive: true });
    writeFileSync(path.join(root, ".tokens-per-ticket/tpt.mjs"), 'console.log("ran checkout copy")\n');
    const run = () => execFileSync("sh", ["-c", HOOK_COMMAND], { cwd: os.tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" }).trim();

    assert.equal(run(), "ran checkout copy");
    const copy = trustedCliPath(root) ?? "";
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, 'console.log("ran trusted copy")\n');
    assert.equal(run(), "ran trusted copy");
  });

  it("tells the session when a branch carries a different CLI, without switching to it", async () => {
    const root = productRepo("jane/eng-47-x");
    mkdirSync(path.join(root, ".tokens-per-ticket"), { recursive: true });
    writeFileSync(path.join(root, ".tokens-per-ticket/tpt.mjs"), "// v1\n");
    refreshTrustedCli(root, { replace: true });
    writeFileSync(path.join(root, ".tokens-per-ticket/tpt.mjs"), "// v2 from a branch\n");
    const output = await handleHook({ hook_event_name: "SessionStart", session_id: "s-cli", cwd: root }, connected, recorder().deps);
    assert.match(output.systemMessage ?? "", /different \.tokens-per-ticket\/tpt\.mjs than the copy the hooks run/);
    assert.equal(readFileSync(trustedCliPath(root) ?? "", "utf8"), "// v1\n");
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
    assert.ok(first.includes("added SessionStart hook"));
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "./team-hook.sh");
    assert.ok(settings.permissions.allow.includes("Bash(npm test)"));
    assert.deepEqual(mergeHookSettings(settings), []);
  });

  it("replaces a tokens-per-ticket hook written by an older version, keeping the repo's own", () => {
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ command: "./team-hook.sh" }, { command: "node", args: ["${CLAUDE_PROJECT_DIR}/.tokens-per-ticket/tpt.mjs", "hook"] }] },
        ],
      },
    };
    assert.ok(mergeHookSettings(settings).includes("updated SessionStart hook"));
    assert.deepEqual(settings.hooks.SessionStart[0], { hooks: [{ command: "./team-hook.sh" }] });
    assert.equal((settings.hooks.SessionStart[1].hooks[0] as { command: string }).command, HOOK_COMMAND);
  });
});

function realpath(file: string | undefined): string {
  return file ? execFileSync("realpath", [file], { encoding: "utf8" }).trim() : "";
}
