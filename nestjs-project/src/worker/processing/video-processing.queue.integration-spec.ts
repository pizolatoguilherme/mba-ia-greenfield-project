import { randomBytes } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
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
import { generateTestVideo } from '../../test/video-fixtures';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { generatePublicId } from '../../videos/public-id.util';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../../videos/videos.queue';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Full queue path with a real BullMQ Worker: a job added to
 * `video-processing` in Redis is consumed by VideoProcessingProcessor
 * (registered by @nestjs/bullmq), which reads MinIO and writes Postgres.
 */
describe('video-processing queue → worker (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let clip: Buffer;

  async function createProcessingVideo(body: Buffer): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Clip',
        filename: 'clip.mp4',
        size: body.length,
        content_type: 'video/mp4',
        status: VideoStatus.PROCESSING,
      }),
    );
    await storage.putObject(
      storage.videosBucket,
      videoSourceKey(video.id),
      body,
      'video/mp4',
    );
    return video;
  }

  function enqueue(videoId: string) {
    return queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: videoId, ...PROCESS_VIDEO_JOB_OPTIONS },
    );
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
      providers: [VideoProcessingProcessor],
    }).compile();

    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
    await moduleRef.init();

    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    clip = await generateTestVideo({ withAudio: true });
  }, 60000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'queue-worker@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Queue Worker',
      nickname: 'queueworker',
      user_id: user.id,
    });
  });

  it('should consume process-video from Redis and move the video to ready', async () => {
    const video = await createProcessingVideo(clip);

    const job = await enqueue(video.id);

    const found = await waitFor(
      () => videoRepository.findOneByOrFail({ id: video.id }),
      (v) => v.status !== VideoStatus.PROCESSING,
    );
    expect(found.status).toBe(VideoStatus.READY);
    expect(found.thumbnail_key).toBe(`${video.id}/auto.jpg`);
    expect(found.duration_seconds).toBeGreaterThan(0);
    await expect(
      waitFor(
        () => job.getState(),
        (state) => state === 'completed',
      ),
    ).resolves.toBe('completed');
  }, 60000);

  it('should fail unreadable media once, without retry, as unreadable_media', async () => {
    const video = await createProcessingVideo(randomBytes(64 * 1024));

    const job = await enqueue(video.id);

    await waitFor(
      () => job.getState(),
      (state) => state === 'failed',
    );
    const failedJob = await queue.getJob(video.id);
    expect(failedJob?.attemptsMade).toBe(1);
    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.FAILED);
    expect(found.failure_reason).toBe('unreadable_media');
  }, 60000);
});
