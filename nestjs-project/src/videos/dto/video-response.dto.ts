import type { Video, VideoStatus } from '../entities/video.entity';

export class SignedUrlDto {
  /** Presigned GET URL on the public storage endpoint. */
  url: string;

  /** ISO-8601 instant when the URL stops working. */
  expiresAt: string;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/**
 * Public view of a video (GET /videos/:publicId). Internal fields — `id`,
 * `upload_id`, `channel_id`, `metadata` — are never exposed (TD-08, TD-06).
 */
export class VideoResponseDto {
  publicId: string;
  title: string;
  status: VideoStatus;
  failureReason: string | null;
  filename: string;
  size: number;
  contentType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  container: string | null;
  /** Presigned thumbnail (6 h); null until the worker stores it. */
  thumbnail: SignedUrlDto | null;
  createdAt: string;

  static fromEntity(
    video: Video,
    thumbnail: SignedUrlDto | null,
  ): VideoResponseDto {
    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      failureReason: video.failure_reason,
      filename: video.filename,
      // bigint columns arrive as strings from the pg driver.
      size: Number(video.size),
      contentType: video.content_type,
      durationSeconds: toNumberOrNull(video.duration_seconds),
      width: video.width,
      height: video.height,
      videoCodec: video.video_codec,
      audioCodec: video.audio_codec,
      bitrate: toNumberOrNull(video.bitrate),
      container: video.container,
      thumbnail,
      createdAt: video.created_at.toISOString(),
    };
  }
}
