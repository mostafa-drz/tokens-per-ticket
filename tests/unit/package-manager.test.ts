import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  detectPackageManager,
  flagsTakenByNpm,
  installCommand,
  scriptCommand,
} from "../../src/lib/package-manager.ts";

describe("detectPackageManager", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tpt-pm-"));
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the packageManager field first", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }));
    writeFileSync(path.join(dir, "package-lock.json"), "{}");
    assert.equal(detectPackageManager(dir, {}), "pnpm");
  });

  it("falls back to the lockfile, so an npm product repo gets npm commands", () => {
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "package-lock.json"), "{}");
    assert.equal(detectPackageManager(dir, {}), "npm");
  });

  it("then the running package manager, then npm", () => {
    assert.equal(detectPackageManager(dir, { npm_config_user_agent: "yarn/1.22.22 npm/? node/v22" }), "yarn");
    assert.equal(detectPackageManager(dir, {}), "npm");
  });
});

describe("scriptCommand", () => {
  it("puts npm's -- separator before arguments, and only then", () => {
    assert.equal(scriptCommand("npm", "ticket:start", ["ENG-1", "--print"]), "npm run ticket:start -- ENG-1 --print");
    assert.equal(scriptCommand("npm", "ticket:report"), "npm run ticket:report");
  });

  it("passes arguments straight through for the others", () => {
    assert.equal(scriptCommand("pnpm", "ticket:start", ["ENG-1", "--print"]), "pnpm ticket:start ENG-1 --print");
    assert.equal(scriptCommand("yarn", "ticket:report", ["ENG-1"]), "yarn ticket:report ENG-1");
    assert.equal(scriptCommand("bun", "ticket:report", ["ENG-1"]), "bun run ticket:report ENG-1");
    assert.equal(installCommand("npm"), "npm install");
  });
});

describe("flagsTakenByNpm", () => {
  // What npm 11 sets for `npm run ticket:start ENG-1 --print --base origin/main`.
  const npmEnv = { npm_config_user_agent: "npm/11.6.4 node/v22.17.1", npm_config_print: "true", npm_config_base: "true" };

  it("names the script flags npm kept as its own config", () => {
    assert.deepEqual(flagsTakenByNpm(["print", "base", "help"], npmEnv), ["print", "base"]);
  });

  it("ignores other package managers and correctly separated arguments", () => {
    assert.deepEqual(flagsTakenByNpm(["print"], { ...npmEnv, npm_config_user_agent: "pnpm/10.20.0 npm/? node/v22" }), []);
    assert.deepEqual(flagsTakenByNpm(["print"], { npm_config_user_agent: "npm/11.6.4 node/v22.17.1" }), []);
  });
});
