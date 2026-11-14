import { spawn } from 'node:child_process';

/** Largest thumbnail width; narrower sources keep their width (TD-07). */
export const THUMBNAIL_MAX_WIDTH = 1280;

/**
 * Extracts one JPEG frame at `offsetSeconds` from a URL. `-ss` before `-i`
 * makes ffmpeg seek on the input (HTTP range) instead of decoding up to the
 * offset; the image is streamed to stdout, never written to disk (TD-07).
 */
export function extractThumbnail(
  url: string,
  offsetSeconds: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v',
      'error',
      '-ss',
      offsetSeconds.toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      `scale=w=min(${THUMBNAIL_MAX_WIDTH}\\,iw):h=-2`,
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const image = Buffer.concat(stdout);
      if (code !== 0 || image.length === 0) {
        const detail = Buffer.concat(stderr).toString().trim();
        reject(
          new Error(
            `ffmpeg thumbnail extraction failed (code ${code})${detail ? `: ${detail}` : ''}`,
          ),
        );
        return;
      }
      resolve(image);
    });
  });
}
