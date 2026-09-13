import "dotenv/config";
import { loadConfig } from "./config.js";
import { initDb } from "./db/schema.js";
import { Store } from "./db/store.js";
import { TokenEncryption } from "./crypto/token-encryption.js";
import { SessionManager } from "./auth/session.js";
import { createApp } from "./server.js";

const config = loadConfig();
const db = initDb(config.dbPath);
const store = new Store(db);
const encryption = new TokenEncryption(
  config.dataDir,
  config.tokenEncryptionKey,
);
const sessions = new SessionManager(config.dataDir, config.sessionSecret);

const app = createApp({
  config,
  store,
  encryption,
  sessions,
  oauth: {
    clientId: config.githubClientId,
    clientSecret: config.githubClientSecret,
    redirectUri: config.githubRedirectUri,
  },
  fetchImpl: fetch,
});

app.listen(config.port, () => {
  console.log(`gmiscore listening on http://127.0.0.1:${config.port}`);
});
