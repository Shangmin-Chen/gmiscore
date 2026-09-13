import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COOKIE_NAME = "gmiscore_session";
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_SEC = Math.floor(SESSION_MAX_AGE_MS / 1000);

function loadSessionSecret(dataDir: string, envSecret?: string): Buffer {
  if (envSecret) {
    return Buffer.from(envSecret, "utf8");
  }
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, "session.key");
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export class SessionManager {
  private secret: Buffer;

  constructor(dataDir: string, envSecret?: string) {
    this.secret = loadSessionSecret(dataDir, envSecret);
  }

  sign(userId: number): string {
    const ts = Date.now().toString();
    const payload = `${userId}.${ts}`;
    const sig = createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${sig}`;
  }

  verify(cookieValue: string, now = Date.now()): number | null {
    const parts = cookieValue.split(".");
    if (parts.length !== 3) return null;
    const [userIdStr, ts, sig] = parts;
    if (!userIdStr || !ts || !sig) return null;

    const tsNum = parseInt(ts, 10);
    if (Number.isNaN(tsNum)) return null;
    if (now - tsNum > SESSION_MAX_AGE_MS) return null;
    if (tsNum > now + 60_000) return null;

    const payload = `${userIdStr}.${ts}`;
    const expected = createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
    try {
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length) return null;
      if (!timingSafeEqual(sigBuf, expBuf)) return null;
    } catch {
      return null;
    }
    const userId = parseInt(userIdStr, 10);
    return Number.isNaN(userId) ? null : userId;
  }
}

export { COOKIE_NAME };
