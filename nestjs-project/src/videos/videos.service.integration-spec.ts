import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidPartNumberException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { autoThumbnailKey, videoSourceKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import { VideosModule } from './videos.module';
import { VIDEO_PROCESSING_QUEUE } from './videos.queue';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const PART_SIZE = 16777216;

// Presigned URLs are fetched from inside the container in this suite.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let videosService: VideosService;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let processingQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        VideosModule,
      ],
    }).compile();
    await moduleRef.init();

    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    channelsService = moduleRef.get(ChannelsService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await processingQueue.obliterate({ force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${++counter}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { user, channel };
  }

  const dto: CreateVideoDto = {
    title: 'My video',
    filename: 'clip.mp4',
    size: 1073741824,
    contentType: 'video/mp4',
  };

  describe('initiateUpload', () => {
    it('should persist a draft with upload_id on the user channel', async () => {
      const { user, channel } = await createUserWithChannel();

      const result = await videosService.initiateUpload(user.id, dto);

      expect(result).toEqual({
        publicId: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/) as string,
        title: 'My video',
        status: VideoStatus.DRAFT,
        partSize: 16777216,
        partCount: 64,
      });

      const video = await videoRepository.findOneByOrFail({
        public_id: result.publicId,
      });
      expect(video).toMatchObject({
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        title: 'My video',
        filename: 'clip.mp4',
        size: 1073741824,
        content_type: 'video/mp4',
      });
      expect(video.upload_id).toEqual(expect.any(String));
    });

    it('should open an empty multipart upload at {id}/source', async () => {
      const { user } = await createUserWithChannel();

      const result = await videosService.initiateUpload(user.id, dto);
      const video = await videoRepository.findOneByOrFail({
        public_id: result.publicId,
      });

      const parts = await storageService.listParts(
        storageService.videosBucket,
        videoSourceKey(video.id),
        video.upload_id as string,
      );
      expect(parts).toEqual([]);
    });

    it('should retry with a new public_id when the generated one collides', async () => {
      const { user } = await createUserWithChannel();
      const first = await videosService.initiateUpload(user.id, dto);
      jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValueOnce(first.publicId)
        .mockReturnValueOnce('freshId-123');

      const second = await videosService.initiateUpload(user.id, dto);

      expect(second.publicId).toBe('freshId-123');
      await expect(videoRepository.count()).resolves.toBe(2);
    });
  });

  describe('signPartUrls', () => {
    const twoPartDto: CreateVideoDto = { ...dto, size: 2 * PART_SIZE };

    it('should sign a URL that accepts the PUT of a part', async () => {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(
        user.id,
        twoPartDto,
      );

      const result = await videosService.signPartUrls(publicId, user.id, {
        partNumbers: [1],
      });

      expect(result.parts).toHaveLength(1);
      const put = await fetch(result.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(PART_SIZE),
      });
      expect(put.status).toBe(200);

      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      const parts = await storageService.listParts(
        storageService.videosBucket,
        videoSourceKey(video.id),
        video.upload_id as string,
      );
      expect(parts.map((p) => p.partNumber)).toEqual([1]);
    });

    it('should advance last_activity_at', async () => {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(
        user.id,
        twoPartDto,
      );
      const before = (
        await videoRepository.findOneByOrFail({ public_id: publicId })
      ).last_activity_at;
      await new Promise((resolve) => setTimeout(resolve, 50));

      await videosService.signPartUrls(publicId, user.id, {
        partNumbers: [1, 2],
      });

      const after = (
        await videoRepository.findOneByOrFail({ public_id: publicId })
      ).last_activity_at;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('should reject a part number above partCount with INVALID_PART_NUMBER', async () => {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(
        user.id,
        twoPartDto,
      );

      await expect(
        videosService.signPartUrls(publicId, user.id, { partNumbers: [3] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });
  });

  describe('listUploadedParts', () => {
    it('should return exactly the parts already stored, with etag and size', async () => {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(user.id, {
        ...dto,
        size: 3 * PART_SIZE,
      });
      const { parts: urls } = await videosService.signPartUrls(
        publicId,
        user.id,
        { partNumbers: [3, 1] },
      );
      const etags = new Map<number, string | null>();
      for (const { partNumber, url } of urls) {
        const put = await fetch(url, {
          method: 'PUT',
          body: new Uint8Array(PART_SIZE),
        });
        etags.set(partNumber, put.headers.get('etag'));
      }

      const result = await videosService.listUploadedParts(publicId, user.id);

      expect(result.parts).toEqual([
        { partNumber: 1, etag: etags.get(1), size: PART_SIZE },
        { partNumber: 3, etag: etags.get(3), size: PART_SIZE },
      ]);
    });
  });

  describe('completeUpload', () => {
    async function uploadTwoParts(userId: string) {
      const lastPartSize = 4 * 1024 * 1024;
      const { publicId } = await videosService.initiateUpload(userId, {
        ...dto,
        size: PART_SIZE + lastPartSize,
      });
      const { parts: urls } = await videosService.signPartUrls(
        publicId,
        userId,
        { partNumbers: [1, 2] },
      );
      const parts: { partNumber: number; etag: string }[] = [];
      for (const { partNumber, url } of urls) {
        const put = await fetch(url, {
          method: 'PUT',
          body: new Uint8Array(partNumber === 1 ? PART_SIZE : lastPartSize),
        });
        parts.push({ partNumber, etag: put.headers.get('etag') as string });
      }
      return { publicId, parts, totalSize: PART_SIZE + lastPartSize };
    }

    it('should assemble the object, move to processing and enqueue jobId = videoId', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts, totalSize } = await uploadTwoParts(user.id);

      const result = await videosService.completeUpload(publicId, user.id, {
        parts: [...parts].reverse(),
      });

      expect(result).toEqual({ publicId, status: VideoStatus.PROCESSING });
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      await expect(
        storageService.headObject(
          storageService.videosBucket,
          videoSourceKey(video.id),
        ),
      ).resolves.toEqual({ contentLength: totalSize });

      const job = await processingQueue.getJob(video.id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: video.id });
      expect(job?.opts.attempts).toBe(3);
    });

    it('should not create a second job when complete is repeated', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts } = await uploadTwoParts(user.id);
      await videosService.completeUpload(publicId, user.id, { parts });

      await expect(
        videosService.completeUpload(publicId, user.id, { parts }),
      ).rejects.toBeInstanceOf(VideoNotDraftException);

      await expect(processingQueue.count()).resolves.toBe(1);
    });
  });

  describe('findByPublicId', () => {
    it('should return a ready video with a working signed thumbnail URL', async () => {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(user.id, dto);
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      const thumbnailKey = autoThumbnailKey(video.id);
      await storageService.putObject(
        storageService.thumbnailsBucket,
        thumbnailKey,
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        'image/jpeg',
      );
      await videoRepository.update(
        { id: video.id },
        { status: VideoStatus.READY, thumbnail_key: thumbnailKey },
      );

      const result = await videosService.findByPublicId(publicId);

      expect(result.status).toBe(VideoStatus.READY);
      expect(result.thumbnail).not.toBeNull();
      const res = await fetch(result.thumbnail!.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    it('should return thumbnail null for a draft', async () => {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(user.id, dto);

      const result = await videosService.findByPublicId(publicId);

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.thumbnail).toBeNull();
    });

    it('should throw VIDEO_NOT_FOUND for an unknown publicId', async () => {
      await expect(
        videosService.findByPublicId('AAAAAAAAAAA'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('signDelivery', () => {
    async function createVideoWithSource(
      status: VideoStatus,
      filename = 'clip.mp4',
    ): Promise<string> {
      const { user } = await createUserWithChannel();
      const { publicId } = await videosService.initiateUpload(user.id, {
        ...dto,
        filename,
      });
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      await storageService.putObject(
        storageService.videosBucket,
        videoSourceKey(video.id),
        Buffer.alloc(8192, 7),
        'video/mp4',
      );
      await videoRepository.update({ id: video.id }, { status });
      return publicId;
    }

    it('should sign a stream URL that serves Range requests with 206', async () => {
      const publicId = await createVideoWithSource(VideoStatus.READY);

      const { url } = await videosService.signDelivery(publicId, 'stream');

      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-1023/8192');
      expect((await res.arrayBuffer()).byteLength).toBe(1024);
    });

    it('should sign a download URL with an attachment Content-Disposition', async () => {
      const publicId = await createVideoWithSource(
        VideoStatus.READY,
        '../vídeo "final".mp4',
      );

      const { url } = await videosService.signDelivery(publicId, 'download');

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(8192);
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="video final.mp4"; filename*=UTF-8''${encodeURIComponent('vídeo final.mp4')}`,
      );
    });

    it('should throw VIDEO_NOT_READY for a processing video', async () => {
      const publicId = await createVideoWithSource(VideoStatus.PROCESSING);

      await expect(
        videosService.signDelivery(publicId, 'stream'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });
});
