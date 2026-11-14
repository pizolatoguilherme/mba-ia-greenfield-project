import { spawn } from 'node:child_process';
import { UnreadableMediaError } from './unreadable-media.error';

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  [key: string]: unknown;
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  size?: string;
  [key: string]: unknown;
}

export interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

/**
 * Runs `ffprobe` against a URL (read by HTTP range requests, never downloaded
 * to disk). Arguments are passed as an array, without a shell (TD-06).
 */
export function probeMedia(url: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // Spawn failures (e.g. ffprobe missing) are infrastructure errors: retryable.
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString().trim();
        reject(
          new UnreadableMediaError(
            `ffprobe exited with code ${code}${detail ? `: ${detail}` : ''}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString()) as FfprobeOutput);
      } catch {
        reject(new UnreadableMediaError('ffprobe returned invalid JSON'));
      }
    });
  });
}
