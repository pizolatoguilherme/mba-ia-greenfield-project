import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import storageConfig from '../../config/storage.config';
import { autoThumbnailKey, videoSourceKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../../videos/videos.queue';
import { probeMedia } from '../media/ffprobe';
import { mapProbeToMetadata } from '../media/probe-mapper';
import { extractThumbnail } from '../media/thumbnail';
import { UnreadableMediaError } from '../media/unreadable-media.error';

const UNREADABLE_MEDIA = 'unreadable_media';
const PROCESSING_ERROR = 'processing_error';
const THUMBNAIL_POSITION = 0.1; // 10% of the duration (TD-07)

/**
 * Consumes `process-video` (TD-06): probes the source through a presigned GET
 * on the internal endpoint (TD-04) and moves `processing` → `ready`, or to
 * `failed` with the TD-10 failure reasons.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // Redelivered or stale job (TD-05/TD-10): nothing to do.
      return;
    }

    const sourceUrl = await this.storageService.signGetObject(
      this.storageService.videosBucket,
      videoSourceKey(video.id),
      { expiresIn: this.config.deliveryUrlTtlSeconds, audience: 'internal' },
    );

    let metadata: ReturnType<typeof mapProbeToMetadata>;
    try {
      metadata = mapProbeToMetadata(await probeMedia(sourceUrl));
    } catch (err) {
      if (err instanceof UnreadableMediaError) {
        await this.markFailed(video.id, UNREADABLE_MEDIA);
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      // jsonb `metadata` is a plain object; TypeORM's deep-partial type
      // cannot express Record<string, unknown>.
      metadata as QueryDeepPartialEntity<Video>,
    );

    // Thumbnail failures are retryable (SI-03.9 rules); `ready` comes last.
    const offset = (metadata.duration_seconds ?? 0) * THUMBNAIL_POSITION;
    const thumbnail = await extractThumbnail(sourceUrl, offset);
    const thumbnailKey = autoThumbnailKey(video.id);
    await this.storageService.putObject(
      this.storageService.thumbnailsBucket,
      thumbnailKey,
      thumbnail,
      'image/jpeg',
    );

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      { thumbnail_key: thumbnailKey, status: VideoStatus.READY },
    );
  }

  /** Final attempt exhausted (TD-02 retries) → `failed` / `processing_error`. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData> | undefined): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    await this.markFailed(job.data.videoId, PROCESSING_ERROR);
    this.logger.warn(
      `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${job.failedReason}`,
    );
  }

  /** Only a video still in `processing` can fail; other states are left as is. */
  private async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
  }
}
