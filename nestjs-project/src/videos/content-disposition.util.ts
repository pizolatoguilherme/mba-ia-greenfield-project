const FALLBACK_FILENAME = 'video';

/**
 * Removes characters that could break the header or point outside the file
 * name: control characters, quotes, backslashes, slashes and `..` segments.
 */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\p{Cc}"\\]/gu, '')
    .split('/')
    .filter((segment) => segment !== '..' && segment !== '.')
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_FILENAME;
}

/** ASCII-only version of a name: accents stripped, other non-ASCII → `_`. */
function toAsciiFallback(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_');
}

/**
 * `attachment` Content-Disposition for downloads (TD-09). Non-ASCII names get
 * an ASCII `filename` plus the RFC 5987 `filename*` with the UTF-8 original.
 */
export function attachmentDisposition(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = toAsciiFallback(safe);
  if (ascii === safe) {
    return `attachment; filename="${safe}"`;
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
