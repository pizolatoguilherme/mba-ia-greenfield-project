import { randomBytes } from 'node:crypto';

/**
 * Random 11-character base64url identifier exposed in video URLs.
 * 8 random bytes (64 bits) encode to exactly 11 base64url characters.
 */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
