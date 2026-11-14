import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestVideoOptions {
  withAudio: boolean;
  durationSeconds?: number;
  /** WIDTHxHEIGHT, default 320x240. */
  size?: string;
}

/**
 * Generates a short MP4 with ffmpeg's lavfi test sources (H.264,
 * optional AAC tone). Test-only helper: writes to a temp dir and returns bytes.
 */
export async function generateTestVideo({
  withAudio,
  durationSeconds = 2,
  size = '320x240',
}: TestVideoOptions): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  const out = join(dir, 'fixture.mp4');
  const args = [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${size}:rate=25`,
    ...(withAudio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`]
      : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []),
    '-movflags',
    '+faststart',
    out,
  ];
  try {
    await execFileAsync('ffmpeg', args);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads width/height from a baseline or progressive JPEG's SOF segment. */
export function readJpegSize(image: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < image.length) {
    const marker = image.readUInt16BE(offset);
    const length = image.readUInt16BE(offset + 2);
    if (marker === 0xffc0 || marker === 0xffc2) {
      return {
        height: image.readUInt16BE(offset + 5),
        width: image.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error('No SOF segment found in JPEG');
}
