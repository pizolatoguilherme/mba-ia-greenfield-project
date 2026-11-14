import type { FfprobeOutput, FfprobeStream } from './ffprobe';
import { UnreadableMediaError } from './unreadable-media.error';

export interface VideoMetadataColumns {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  container: string | null;
  metadata: Record<string, unknown>;
}

const SUMMARY_FORMAT_KEYS = ['format_name', 'duration', 'bit_rate', 'size'];
const SUMMARY_STREAM_KEYS = [
  'index',
  'codec_type',
  'codec_name',
  'width',
  'height',
  'duration',
  'bit_rate',
  'pix_fmt',
  'sample_rate',
  'channels',
];

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function pick(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  );
}

/**
 * Maps ffprobe output to the typed columns plus a trimmed `metadata` summary
 * (TD-06 Revision). A file without a video stream is unreadable media.
 */
export function mapProbeToMetadata(probe: FfprobeOutput): VideoMetadataColumns {
  const streams: FfprobeStream[] = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new UnreadableMediaError('No video stream found');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = probe.format ?? {};

  return {
    duration_seconds: toNumber(format.duration ?? video.duration),
    width: toInteger(video.width),
    height: toInteger(video.height),
    video_codec: video.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    bitrate: toInteger(format.bit_rate ?? video.bit_rate),
    container: format.format_name ?? null,
    metadata: {
      format: pick(format, SUMMARY_FORMAT_KEYS),
      streams: streams.map((s) => pick(s, SUMMARY_STREAM_KEYS)),
    },
  };
}
