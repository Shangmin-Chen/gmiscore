import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  generateState,
  isStateValid,
  type OAuthConfig,
} from "../src/auth/github.js";
import { createTestEnv } from "./helpers.js";

const oauth: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1:3000/auth/github/callback",
};

describe("OAuth", () => {
  let env = createTestEnv();
  afterEach(() => env.cleanup());

  it("builds authorize URL with exact scopes read:user repo", () => {
    const url = buildAuthorizeUrl(oauth, "abc123");
    assert.ok(url.includes("scope=read%3Auser+repo"));
    assert.ok(url.includes("client_id=test-client-id"));
    assert.ok(
      url.includes(
        "redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fauth%2Fgithub%2Fcallback",
      ),
    );
  });

  it("rejects expired OAuth state", () => {
    env = createTestEnv();
    const state = generateState();
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    env.store.createOAuthState(state, elevenMinAgo);
    const stored = env.store.getOAuthState(state)!;
    assert.equal(isStateValid(stored.created_at), false);
  });

  it("accepts fresh OAuth state within 10 minutes", () => {
    env = createTestEnv();
    const state = generateState();
    env.store.createOAuthState(state, new Date().toISOString());
    const stored = env.store.getOAuthState(state)!;
    assert.equal(isStateValid(stored.created_at), true);
  });

  it("state mismatch: stored state differs from callback state", () => {
    env = createTestEnv();
    env.store.createOAuthState("expected-state", new Date().toISOString());
    const callbackState = "wrong-state";
    const stored = env.store.getOAuthState(callbackState);
    assert.equal(stored, undefined);
  });
});
