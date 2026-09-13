import { randomBytes } from "node:crypto";
import type { Store } from "../db/store.js";
import type { TokenEncryption } from "../crypto/token-encryption.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export function generateState(): string {
  return randomBytes(32).toString("hex");
}

export function buildAuthorizeUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "read:user repo",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function isStateValid(storedAt: string, now = Date.now()): boolean {
  const created = new Date(storedAt).getTime();
  return now - created <= OAUTH_STATE_TTL_MS;
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
    },
  );
  return response.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  );
  return response.json() as Promise<TokenResponse>;
}

export async function ensureFreshToken(
  store: Store,
  encryption: TokenEncryption,
  userId: number,
  config: OAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const user = store.getUserById(userId);
  if (!user) throw new Error("User not found");

  let accessToken = encryption.decrypt(user.encrypted_token);

  if (user.encrypted_refresh_token && user.token_expires_at) {
    const expiresAt = new Date(user.token_expires_at).getTime();
    if (Date.now() >= expiresAt - 60_000) {
      const refreshToken = encryption.decrypt(user.encrypted_refresh_token);
      const tokenResp = await refreshAccessToken(config, refreshToken, fetchImpl);
      if (tokenResp.error || !tokenResp.access_token) {
        throw new TokenRefreshError(
          tokenResp.error_description ??
            tokenResp.error ??
            "GitHub token refresh failed; reconnect your account.",
        );
      }
      accessToken = tokenResp.access_token;
      const now = new Date().toISOString();
      const expiresAtNew = tokenResp.expires_in
        ? new Date(Date.now() + tokenResp.expires_in * 1000).toISOString()
        : null;
      store.updateUserToken(
        userId,
        encryption.encrypt(tokenResp.access_token),
        tokenResp.refresh_token
          ? encryption.encrypt(tokenResp.refresh_token)
          : user.encrypted_refresh_token,
        expiresAtNew,
        tokenResp.scope ?? user.token_scopes,
        now,
      );
    }
  }

  return accessToken;
}

export async function fetchViewerProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ githubUserId: string; login: string }> {
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "gmiscore",
    },
    body: JSON.stringify({
      query: `query { viewer { id databaseId login } rateLimit { cost remaining resetAt } }`,
    }),
  });
  const body = (await response.json()) as {
    data?: { viewer?: { databaseId: number | null; login: string; id: string } };
  };
  const viewer = body.data?.viewer;
  if (!viewer) throw new Error("Failed to fetch viewer profile");
  const githubUserId =
    viewer.databaseId != null ? String(viewer.databaseId) : viewer.id;
  return { githubUserId, login: viewer.login };
}
