import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import { videoSourceKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../../videos/videos.queue';

const UPLOAD_ABANDONED = 'upload_abandoned';
const HOUR_MS = 3600 * 1000;

function isNoSuchUpload(err: unknown): boolean {
  return err instanceof Error && err.name === 'NoSuchUpload';
}

/** The two idempotent steps of the hourly sweep (TD-11). */
@Injectable()
export class VideoSweepService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Drafts idle longer than UPLOAD_ABANDON_AFTER_HOURS (measured from
   * `last_activity_at`, video-upload-delivery-limits/TD-04): abort the
   * multipart upload and mark `failed` / `upload_abandoned`.
   */
  async failAbandonedUploads(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.abandonAfterHours * HOUR_MS,
    );
    const abandoned = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, last_activity_at: LessThan(cutoff) },
    });

    let failed = 0;
    for (const video of abandoned) {
      if (video.upload_id) {
        try {
          await this.storageService.abortMultipartUpload(
            this.storageService.videosBucket,
            videoSourceKey(video.id),
            video.upload_id,
          );
        } catch (err) {
          // Already aborted or completed: aborting again is a no-op.
          if (!isNoSuchUpload(err)) throw err;
        }
      }
      const result = await this.videoRepository.update(
        { id: video.id, status: VideoStatus.DRAFT },
        { status: VideoStatus.FAILED, failure_reason: UPLOAD_ABANDONED },
      );
      failed += result.affected ?? 0;
    }
    return failed;
  }

  /**
   * Re-adds `process-video` for every video in `processing`. `jobId = videoId`
   * makes this a no-op while the original job still exists (TD-05), and
   * closes the completed-but-not-enqueued gap.
   */
  async requeueStuckProcessing(): Promise<number> {
    const stuck = await this.videoRepository.find({
      select: { id: true },
      where: { status: VideoStatus.PROCESSING },
    });
    for (const { id } of stuck) {
      await this.processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: id },
        { jobId: id, ...PROCESS_VIDEO_JOB_OPTIONS },
      );
    }
    return stuck.length;
  }
}
