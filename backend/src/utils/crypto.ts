import crypto from 'crypto';
import logger from './logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) throw new Error('ENCRYPTION_KEY environment variable is not set');
  const key = Buffer.from(keyHex, 'utf8');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (UTF-8)');
  }
  return key;
}

export function encrypt(plaintext: string): string {
  logger.debug('Encrypting token');
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const result = Buffer.concat([iv, tag, encrypted]).toString('base64');
  logger.debug('Token encrypted successfully');
  return result;
}

export function decrypt(ciphertext: string): string {
  logger.debug('Decrypting token');
  const key = getKey();
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const result = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  logger.debug('Token decrypted successfully');
  return result;
}
