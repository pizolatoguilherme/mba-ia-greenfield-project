import {
  attachmentDisposition,
  sanitizeFilename,
} from './content-disposition.util';

describe('sanitizeFilename', () => {
  it('should remove double quotes and backslashes', () => {
    expect(sanitizeFilename('a"b\\c.mp4')).toBe('abc.mp4');
  });

  it('should drop path traversal segments and slashes', () => {
    expect(sanitizeFilename('../a"b.mp4')).toBe('ab.mp4');
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
  });

  it('should remove control characters', () => {
    expect(sanitizeFilename('clip\r\n\t.mp4')).toBe('clip.mp4');
  });

  it('should fall back to "video" when nothing is left', () => {
    expect(sanitizeFilename('')).toBe('video');
    expect(sanitizeFilename('../"/')).toBe('video');
  });
});

describe('attachmentDisposition', () => {
  it('should use a plain filename for ASCII names', () => {
    expect(attachmentDisposition('meu-video.mp4')).toBe(
      'attachment; filename="meu-video.mp4"',
    );
  });

  it('should add an ASCII fallback and filename* for accented names', () => {
    expect(attachmentDisposition('férias.mp4')).toBe(
      `attachment; filename="ferias.mp4"; filename*=UTF-8''f%C3%A9rias.mp4`,
    );
  });

  it('should replace non-Latin characters in the ASCII fallback', () => {
    expect(attachmentDisposition('動画.mp4')).toBe(
      `attachment; filename="__.mp4"; filename*=UTF-8''${encodeURIComponent('動画.mp4')}`,
    );
  });

  it('should never let quotes or traversal reach the header', () => {
    const header = attachmentDisposition('../a"b.mp4');

    expect(header).toBe('attachment; filename="ab.mp4"');
  });
});
