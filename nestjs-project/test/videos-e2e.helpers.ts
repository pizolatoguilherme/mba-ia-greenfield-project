import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ChannelsService } from '../src/channels/channels.service';
import type { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { autoThumbnailKey, videoSourceKey } from '../src/storage/storage-keys';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/public-id.util';

const PASSWORD = 'password123';

export interface VideosE2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
}

export interface LoggedInUser {
  user: User;
  channel: Channel;
  accessToken: string;
}

/**
 * Boots AppModule like main.ts. Presigned URLs are fetched from inside the
 * container in tests, so the public S3 endpoint points at the Compose service.
 */
export async function bootstrapVideosApp(): Promise<VideosE2eContext> {
  process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return { app, dataSource: moduleFixture.get(DataSource) };
}

export async function resetVideosState(ctx: VideosE2eContext): Promise<void> {
  await cleanAllTables(ctx.dataSource);
  ctx.app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
}

/** Creates a confirmed user with a channel and logs in via POST /auth/login. */
export async function createLoggedInUser(
  ctx: VideosE2eContext,
  email: string,
): Promise<LoggedInUser> {
  const userRepository = ctx.dataSource.getRepository(User);
  const user = await userRepository.save(
    userRepository.create({
      email,
      password: await argon2.hash(PASSWORD),
      is_confirmed: true,
    }),
  );
  const channel = await ctx.app
    .get(ChannelsService)
    .createChannel(user.id, user.email);

  const login = await request(ctx.app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    user,
    channel,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}

export interface SeedVideoOptions {
  status: VideoStatus;
  failureReason?: string | null;
  /** Stores this body at `{id}/source` in the videos bucket. */
  source?: Buffer;
  /** Stores a JPEG at `{id}/auto.jpg` and sets `thumbnail_key`. */
  withThumbnail?: boolean;
  filename?: string;
}

/** Seeds a video row (and its objects) directly, bypassing the worker. */
export async function seedVideo(
  ctx: VideosE2eContext,
  channel: Channel,
  options: SeedVideoOptions,
): Promise<Video> {
  const repository = ctx.dataSource.getRepository(Video);
  const storage = ctx.app.get(StorageService);
  const isReady = options.status === VideoStatus.READY;
  const video = await repository.save(
    repository.create({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'Seeded video',
      filename: options.filename ?? 'seeded.mp4',
      size: options.source?.length ?? 1024,
      content_type: 'video/mp4',
      status: options.status,
      failure_reason: options.failureReason ?? null,
      ...(isReady && {
        duration_seconds: 12.5,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        bitrate: 5000000,
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        metadata: { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } },
      }),
    }),
  );
  if (options.source) {
    await storage.putObject(
      storage.videosBucket,
      videoSourceKey(video.id),
      options.source,
      'video/mp4',
    );
  }
  if (options.withThumbnail) {
    const thumbnailKey = autoThumbnailKey(video.id);
    await storage.putObject(
      storage.thumbnailsBucket,
      thumbnailKey,
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      'image/jpeg',
    );
    await repository.update({ id: video.id }, { thumbnail_key: thumbnailKey });
  }
  return repository.findOneByOrFail({ id: video.id });
}
