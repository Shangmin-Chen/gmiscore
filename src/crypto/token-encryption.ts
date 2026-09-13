import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class TokenDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenDecryptionError";
  }
}

function resolveKeyPath(dataDir: string): string {
  return join(dataDir, "token.key");
}

function loadOrCreateKey(dataDir: string, envKey?: string): Buffer {
  if (envKey) {
    return scryptSync(envKey, "gmiscore-salt", KEY_LENGTH);
  }
  mkdirSync(dataDir, { recursive: true });
  const keyPath = resolveKeyPath(dataDir);
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  const key = randomBytes(KEY_LENGTH);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export class TokenEncryption {
  private key: Buffer;

  constructor(dataDir: string, envKey?: string) {
    this.key = loadOrCreateKey(dataDir, envKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    try {
      const buf = Buffer.from(ciphertext, "base64");
      const iv = buf.subarray(0, IV_LENGTH);
      const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new TokenDecryptionError(
        "Cannot decrypt stored token. TOKEN_ENCRYPTION_KEY may have changed or .data/token.key is missing.",
      );
    }
  }
}
