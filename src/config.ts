import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  githubClientId: string;
  githubClientSecret: string;
  githubRedirectUri: string;
  tokenEncryptionKey?: string;
  sessionSecret?: string;
}

export function loadConfig(): AppConfig {
  const dataDir = join(process.cwd(), ".data");
  mkdirSync(dataDir, { recursive: true });

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri =
    process.env.GITHUB_REDIRECT_URI ??
    "http://127.0.0.1:3000/auth/github/callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set in .env",
    );
  }

  return {
    port: 3000,
    dataDir,
    dbPath: join(dataDir, "gmiscore.sqlite"),
    githubClientId: clientId,
    githubClientSecret: clientSecret,
    githubRedirectUri: redirectUri,
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    sessionSecret: process.env.SESSION_SECRET,
  };
}
