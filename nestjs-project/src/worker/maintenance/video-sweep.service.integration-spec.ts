import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { JobType, Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import { videoSourceKey } from '../../storage/storage-keys';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { generatePublicId } from '../../videos/public-id.util';
import { VIDEO_PROCESSING_QUEUE } from '../../videos/videos.queue';
import { VideoSweepService } from './video-sweep.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR_MS = 3600 * 1000;
const ALL_JOB_STATES: JobType[] = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'completed',
  'failed',
  'waiting-children',
];

describe('VideoSweepService (integration)', () => {
  let moduleRef: TestingModule;
  let sweep: VideoSweepService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let processingQueue: Queue;
  let channel: Channel;

  async function createVideo(
    status: VideoStatus,
    idleHours = 0,
  ): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Clip',
        filename: 'clip.mp4',
        size: 1024,
        content_type: 'video/mp4',
        status,
      }),
    );
    const uploadId = await storage.createMultipartUpload(
      storage.videosBucket,
      videoSourceKey(video.id),
      'video/mp4',
    );
    await videoRepository.update(
      { id: video.id },
      {
        upload_id: uploadId,
        last_activity_at: new Date(Date.now() - idleHours * HOUR_MS),
      },
    );
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
      ],
      providers: [VideoSweepService],
    }).compile();
    await moduleRef.init();

    sweep = moduleRef.get(VideoSweepService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await processingQueue.obliterate({ force: true });
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'sweep@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Sweep', nickname: 'sweep', user_id: user.id });
  });

  describe('failAbandonedUploads', () => {
    it('should fail a draft idle for 25 h and abort its multipart upload', async () => {
      const video = await createVideo(VideoStatus.DRAFT, 25);

      await expect(sweep.failAbandonedUploads(new Date())).resolves.toBe(1);

      const found = await videoRepository.findOneByOrFail({ id: video.id });
      expect(found.status).toBe(VideoStatus.FAILED);
      expect(found.failure_reason).toBe('upload_abandoned');
      await expect(
        storage.listParts(
          storage.videosBucket,
          videoSourceKey(video.id),
          video.upload_id as string,
        ),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('should leave a draft idle for 23 h untouched', async () => {
      const video = await createVideo(VideoStatus.DRAFT, 23);

      await expect(sweep.failAbandonedUploads(new Date())).resolves.toBe(0);

      const found = await videoRepository.findOneByOrFail({ id: video.id });
      expect(found.status).toBe(VideoStatus.DRAFT);
      await expect(
        storage.listParts(
          storage.videosBucket,
          videoSourceKey(video.id),
          video.upload_id as string,
        ),
      ).resolves.toEqual([]);
    });

    it('should still fail the draft when its upload was already aborted', async () => {
      const video = await createVideo(VideoStatus.DRAFT, 25);
      await storage.abortMultipartUpload(
        storage.videosBucket,
        videoSourceKey(video.id),
        video.upload_id as string,
      );

      await expect(sweep.failAbandonedUploads(new Date())).resolves.toBe(1);

      const found = await videoRepository.findOneByOrFail({ id: video.id });
      expect(found.failure_reason).toBe('upload_abandoned');
    });
  });

  describe('requeueStuckProcessing', () => {
    it('should enqueue process-video with jobId = videoId for a processing video without job', async () => {
      const video = await createVideo(VideoStatus.PROCESSING);

      await expect(sweep.requeueStuckProcessing()).resolves.toBe(1);

      const job = await processingQueue.getJob(video.id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('should not duplicate the job of a processing video that already has one', async () => {
      const video = await createVideo(VideoStatus.PROCESSING);
      await processingQueue.add(
        'process-video',
        { videoId: video.id },
        { jobId: video.id },
      );

      await sweep.requeueStuckProcessing();

      const counts = await processingQueue.getJobCounts(...ALL_JOB_STATES);
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      expect(total).toBe(1);
    });
  });
});
