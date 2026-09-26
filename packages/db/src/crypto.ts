import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret storage.
 *
 * Webhook secrets and host access tokens are encrypted at rest with
 * AES-256-GCM. The key comes from `DEVANALYTICS_ENCRYPTION_KEY` (32 random
 * bytes, base64). Ciphertext is `v1.<iv>.<tag>.<data>`, all base64url, so the
 * format is self-describing and can be rotated.
 *
 * These values are decrypted only inside the server process. Nothing in this
 * module is safe to import from a client component, and no API response ever
 * carries a decrypted value.
 */

const VERSION = 'v1';

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      'DEVANALYTICS_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.DEVANALYTICS_ENCRYPTION_KEY;
  if (!raw) throw new MissingEncryptionKeyError();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('DEVANALYTICS_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer = encryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(ciphertext: string, key: Buffer = encryptionKey()): string {
  const [version, ivB64, tagB64, dataB64] = ciphertext.split('.');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** API tokens: `dva_<prefix>_<secret>`. Only the SHA-256 of the whole token is stored. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const token = `dva_${prefix}_${secret}`;
  return { token, hash: hashToken(token), prefix };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
