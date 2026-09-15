import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy.ts";
import { basicAuthOk } from "../../src/lib/basic-auth.ts";

describe("proxy (LEDGER_BASIC_AUTH)", () => {
  afterEach(() => {
    delete process.env.LEDGER_BASIC_AUTH;
  });

  const request = (authorization?: string) =>
    new NextRequest("http://ledger.test/", { headers: authorization ? { authorization } : {} });

  it("lets everything through when no password is configured", () => {
    assert.notEqual(proxy(request()).status, 401);
  });

  it("asks for credentials when a password is configured", () => {
    process.env.LEDGER_BASIC_AUTH = "lead:s3cret";
    const response = proxy(request());
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /Basic/);
  });

  it("accepts the right credentials and rejects the wrong ones", () => {
    process.env.LEDGER_BASIC_AUTH = "lead:s3cret";
    assert.notEqual(proxy(request(`Basic ${btoa("lead:s3cret")}`)).status, 401);
    assert.equal(proxy(request(`Basic ${btoa("lead:guess")}`)).status, 401);
  });

  it("answers a malformed header with 401, not a server error", () => {
    process.env.LEDGER_BASIC_AUTH = "lead:s3cret";
    assert.equal(proxy(request("Basic %%%not-base64")).status, 401);
  });
});

describe("basicAuthOk (re-checked in data access)", () => {
  it("passes when no password is configured", () => {
    assert.equal(basicAuthOk(null, undefined), true);
    assert.equal(basicAuthOk(null, ""), true);
  });

  it("requires the exact credentials when a password is configured", () => {
    assert.equal(basicAuthOk(null, "lead:s3cret"), false);
    assert.equal(basicAuthOk(`Basic ${btoa("lead:s3cret")}`, "lead:s3cret"), true);
    assert.equal(basicAuthOk(`Basic ${btoa("lead:s3cre")}`, "lead:s3cret"), false);
    assert.equal(basicAuthOk(`Bearer ${btoa("lead:s3cret")}`, "lead:s3cret"), false);
    assert.equal(basicAuthOk("Basic %%%", "lead:s3cret"), false);
  });
});
