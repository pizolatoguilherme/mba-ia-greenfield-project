import { randomBytes } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
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
import type { ProcessVideoJobData } from '../../videos/videos.queue';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let withAudio: Buffer;
  let withoutAudio: Buffer;

  const jobFor = (videoId: string) =>
    ({
      data: { videoId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    }) as unknown as Job<ProcessVideoJobData>;

  async function createVideo(
    body: Buffer,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Clip',
        filename: 'clip.mp4',
        size: body.length,
        content_type: 'video/mp4',
        status,
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

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessingProcessor],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(VideoProcessingProcessor);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    [withAudio, withoutAudio] = await Promise.all([
      generateTestVideo({ withAudio: true }),
      generateTestVideo({ withAudio: false }),
    ]);
  }, 60000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Worker',
      nickname: 'worker',
      user_id: user.id,
    });
  });

  it('should move a processing video to ready with its metadata', async () => {
    const video = await createVideo(withAudio);

    await processor.process(jobFor(video.id));

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.READY);
    expect(found.duration_seconds).toBeGreaterThan(1.5);
    expect(found).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(found.bitrate).toBeGreaterThan(0);
    expect(found.container).toContain('mp4');
    expect(found.metadata).not.toBeNull();
    expect(found.thumbnail_key).toBe(`${video.id}/auto.jpg`);
  }, 30000);

  it('should store {id}/auto.jpg in the thumbnails bucket as image/jpeg', async () => {
    const video = await createVideo(withAudio);

    await processor.process(jobFor(video.id));

    const url = await storage.signGetObject(
      storage.thumbnailsBucket,
      `${video.id}/auto.jpg`,
      { expiresIn: 300, audience: 'internal' },
    );
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 30000);

  it('should leave audio_codec null for a video without audio', async () => {
    const video = await createVideo(withoutAudio);

    await processor.process(jobFor(video.id));

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.READY);
    expect(found.audio_codec).toBeNull();
  }, 30000);

  it('should mark random bytes as failed / unreadable_media without retry', async () => {
    const video = await createVideo(randomBytes(64 * 1024));

    await expect(processor.process(jobFor(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.FAILED);
    expect(found.failure_reason).toBe('unreadable_media');
  }, 30000);

  it('should not change a video that is already ready', async () => {
    const video = await createVideo(withAudio, VideoStatus.READY);
    const before = await videoRepository.findOneByOrFail({ id: video.id });

    await processor.process(jobFor(video.id));

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    expect(after).toEqual(before);
  }, 30000);
});
