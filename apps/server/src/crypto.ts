import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption for Plaid access tokens.
 *
 * A Plaid access token is a long-lived credential that can read every
 * transaction on a connected account. Storing it as plaintext in a SQLite file
 * means anything that can read that file — a backup, a sync client, a stray
 * script — inherits full read access to Kamran's bank.
 *
 * So: AES-256-GCM at rest, with the key held in the macOS Keychain rather than
 * on disk. The Keychain is encrypted at rest by the OS and gated on the login
 * password, which is a meaningfully better place for a key than a dotfile.
 *
 * GCM (not CBC) because it authenticates as well as encrypts — a tampered
 * ciphertext fails loudly instead of decrypting to garbage.
 */

const SERVICE = 'org-app';
const ACCOUNT = 'plaid-encryption-key';
const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

function readKeyFromKeychain(): Buffer | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const key = Buffer.from(out, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null; // Not found, or not macOS.
  }
}

function writeKeyToKeychain(key: Buffer): boolean {
  try {
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
        '-w', key.toString('base64'),
        '-U', // update if it already exists
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches the encryption key, creating one on first use.
 *
 * If the Keychain is unavailable (non-macOS, or a locked keychain in a headless
 * context) this throws rather than silently falling back to a file-based key.
 * A quiet downgrade in how a bank credential is protected is exactly the kind
 * of thing that should be loud.
 */
export function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const existing = readKeyFromKeychain();
  if (existing) {
    cachedKey = existing;
    return existing;
  }

  const fresh = randomBytes(32);
  if (!writeKeyToKeychain(fresh)) {
    throw new Error(
      'Could not store the encryption key in the macOS Keychain. Plaid access ' +
        'tokens will not be saved unencrypted — connect a bank only once the ' +
        'Keychain is reachable.',
    );
  }
  cachedKey = fresh;
  return fresh;
}

/** Returns `iv:authTag:ciphertext`, all base64. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96 bits, the GCM standard
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Malformed ciphertext');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];

  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** True when a key can be obtained — used to gate the Plaid UI. */
export function encryptionAvailable(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
