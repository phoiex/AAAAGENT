import { validateHeaderValue } from 'node:http';

export const MAX_API_KEY_BYTES = 4096;
export const MAX_API_KEY_FILE_BYTES = 8192;
/** API keys are opaque credentials. Only trim clipboard/file padding; never extract a prefix or token segment. */
export function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  if (!key || Buffer.byteLength(key, 'utf8') > MAX_API_KEY_BYTES || /[\s\x00-\x1f\x7f-\x9f]/u.test(key)) return undefined;
  try { validateHeaderValue('Authorization', `Bearer ${key}`); }
  catch { return undefined; }
  return key;
}
