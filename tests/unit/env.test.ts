import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { loadEnvLocal } from "../../src/lib/env.ts";

describe("loadEnvLocal", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tpt-env-"));
  const worktree = path.join(dir, "worktree");
  const main = path.join(dir, "main");
  const names = ["TPT_A", "TPT_B", "TPT_C"];

  beforeEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(main, { recursive: true });
    for (const name of names) delete process.env[name];
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of names) delete process.env[name];
  });

  it("falls back to the main checkout's file in a fresh ticket worktree", () => {
    writeFileSync(path.join(main, ".env.local"), "TPT_A=main\n");

    const loaded = loadEnvLocal([worktree, main]);

    assert.deepEqual(loaded, [path.join(main, ".env.local")]);
    assert.equal(process.env.TPT_A, "main");
  });

  it("prefers the shell, then the worktree's own file, over the main checkout", () => {
    writeFileSync(path.join(worktree, ".env.local"), "TPT_A=worktree\nTPT_B=worktree\n");
    writeFileSync(path.join(main, ".env.local"), "TPT_B=main\nTPT_C=main\n");
    process.env.TPT_A = "shell";

    loadEnvLocal([worktree, main]);

    assert.deepEqual(
      names.map((name) => process.env[name]),
      ["shell", "worktree", "main"],
    );
  });

  it("reads a file once when both roots are the same checkout", () => {
    writeFileSync(path.join(main, ".env.local"), "TPT_A=main\n");
    assert.equal(loadEnvLocal([main, `${main}/`]).length, 1);
  });
});
