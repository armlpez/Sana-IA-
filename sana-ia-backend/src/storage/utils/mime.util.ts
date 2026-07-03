import { extname } from 'path';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Derives a MIME type from a storage key's extension. Backend-agnostic (no I/O). */
export function extractMimeType(key: string): string {
  const ext = extname(key).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'image/jpeg';
}
