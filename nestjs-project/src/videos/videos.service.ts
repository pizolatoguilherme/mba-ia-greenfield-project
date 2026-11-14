import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { videoSourceKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  VideoAccessDeniedException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { SignPartUrlsDto } from './dto/sign-part-urls.dto';
import { VideoResponseDto, type SignedUrlDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { attachmentDisposition } from './content-disposition.util';
import { computePartCount } from './upload-parts.util';
import { MAX_VIDEO_SIZE_BYTES } from './videos.constants';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './videos.queue';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  SignPartUrlsResult,
  UploadedPartsResult,
} from './videos.types';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_ATTEMPTS = 5;
const SIZE_EXCEEDED = 'size_exceeded';

export type DeliveryMode = 'stream' | 'download';

// S3 error codes for a part list that does not match the uploaded parts.
const INVALID_PART_LIST_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);

function isInvalidPartListError(err: unknown): boolean {
  return err instanceof Error && INVALID_PART_LIST_ERRORS.has(err.name);
}

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  // TypeORM copies the pg driver error fields (code, detail) onto the instance.
  const { code, detail } = err as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(PUBLIC_ID_COLUMN)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration (Phase 02, 1:1).
      throw new Error(`Channel not found for user ${userId}`);
    }

    const id = randomUUID();
    const bucket = this.storageService.videosBucket;
    const key = videoSourceKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      bucket,
      key,
      dto.contentType,
    );

    try {
      const video = await this.saveDraft({
        id,
        channel_id: channel.id,
        title: dto.title,
        filename: dto.filename,
        size: dto.size,
        content_type: dto.contentType,
        upload_id: uploadId,
      });

      const partSize = this.config.partSizeBytes;
      return {
        publicId: video.public_id,
        title: video.title,
        status: video.status,
        partSize,
        partCount: computePartCount(video.size, partSize),
      };
    } catch (err) {
      await this.storageService.abortMultipartUpload(bucket, key, uploadId);
      throw err;
    }
  }

  /**
   * Loads a video for an upload endpoint: it must exist, belong to the
   * caller's channel and still be in `draft`.
   */
  async findOwnedDraft(publicId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }
    if (video.status !== VideoStatus.DRAFT) throw new VideoNotDraftException();
    return video;
  }

  async signPartUrls(
    publicId: string,
    userId: string,
    dto: SignPartUrlsDto,
  ): Promise<SignPartUrlsResult> {
    const video = await this.findOwnedDraft(publicId, userId);
    const partCount = computePartCount(video.size, this.config.partSizeBytes);
    if (dto.partNumbers.some((n) => n > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }

    const bucket = this.storageService.videosBucket;
    const key = videoSourceKey(video.id);
    const uploadId = video.upload_id as string;
    const signedAt = Date.now();
    const parts = await Promise.all(
      dto.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.signUploadPart(
          bucket,
          key,
          uploadId,
          partNumber,
        ),
      })),
    );

    await this.videoRepository.update(
      { id: video.id },
      { last_activity_at: () => 'now()' },
    );

    return {
      parts,
      expiresAt: new Date(
        signedAt + this.config.partUrlTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  /** Parts already stored for the open multipart upload, ascending. */
  async listUploadedParts(
    publicId: string,
    userId: string,
  ): Promise<UploadedPartsResult> {
    const video = await this.findOwnedDraft(publicId, userId);
    const parts = await this.storageService.listParts(
      this.storageService.videosBucket,
      videoSourceKey(video.id),
      video.upload_id as string,
    );
    return {
      parts: parts.map(({ partNumber, etag, size }) => ({
        partNumber,
        etag,
        size,
      })),
    };
  }

  /**
   * Closes the multipart upload, checks the assembled size and moves the
   * video to `processing`. The row is persisted before the job is enqueued,
   * and `jobId = videoId` keeps the enqueue idempotent (TD-05, TD-10).
   */
  async completeUpload(
    publicId: string,
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedDraft(publicId, userId);
    const bucket = this.storageService.videosBucket;
    const key = videoSourceKey(video.id);

    try {
      await this.storageService.completeMultipartUpload(
        bucket,
        key,
        video.upload_id as string,
        dto.parts,
      );
    } catch (err) {
      if (isInvalidPartListError(err)) throw new InvalidUploadPartsException();
      throw err;
    }

    const head = await this.storageService.headObject(bucket, key);
    if (head && head.contentLength > MAX_VIDEO_SIZE_BYTES) {
      await this.storageService.deleteObject(bucket, key);
      await this.videoRepository.update(
        { id: video.id },
        { status: VideoStatus.FAILED, failure_reason: SIZE_EXCEEDED },
      );
      throw new VideoTooLargeException();
    }

    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING, last_activity_at: () => 'now()' },
    );
    await this.processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      { jobId: video.id, ...PROCESS_VIDEO_JOB_OPTIONS },
    );

    return { publicId: video.public_id, status: VideoStatus.PROCESSING };
  }

  /** Resolves a video by its unique URL (TD-08), with a signed thumbnail. */
  async findByPublicId(publicId: string): Promise<VideoResponseDto> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) throw new VideoNotFoundException();

    const thumbnail = video.thumbnail_key
      ? await this.signPublicGet(
          this.storageService.thumbnailsBucket,
          video.thumbnail_key,
        )
      : null;
    return VideoResponseDto.fromEntity(video, thumbnail);
  }

  /**
   * Presigned GET on the source of a `ready` video (TD-09). The storage
   * serves `Range`/`206` itself; the bytes never pass through the API.
   */
  async signDelivery(
    publicId: string,
    mode: DeliveryMode,
  ): Promise<SignedUrlDto> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    // `download` makes the browser save the file under its original name.
    return this.signPublicGet(
      this.storageService.videosBucket,
      videoSourceKey(video.id),
      mode === 'download' ? attachmentDisposition(video.filename) : undefined,
    );
  }

  /** Presigned GET for clients, valid DELIVERY_URL_TTL_SECONDS (TD-09). */
  private async signPublicGet(
    bucket: string,
    key: string,
    responseContentDisposition?: string,
  ): Promise<SignedUrlDto> {
    const signedAt = Date.now();
    const ttl = this.config.deliveryUrlTtlSeconds;
    const url = await this.storageService.signGetObject(bucket, key, {
      expiresIn: ttl,
      audience: 'public',
      responseContentDisposition,
    });
    return { url, expiresAt: new Date(signedAt + ttl * 1000).toISOString() };
  }

  private async saveDraft(fields: Partial<Video>): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err) || attempt >= MAX_PUBLIC_ID_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
