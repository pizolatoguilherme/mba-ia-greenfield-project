import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { VideoStatus } from '../src/videos/entities/video.entity';
import type { InitiateUploadResult } from '../src/videos/videos.types';
import {
  bootstrapVideosApp,
  createLoggedInUser,
  resetVideosState,
  seedVideo,
  type LoggedInUser,
  type VideosE2eContext,
} from './videos-e2e.helpers';

const SIX_HOURS_MS = 6 * 3600 * 1000;
const MINUTE_MS = 60 * 1000;

describe('videos-get', () => {
  let ctx: VideosE2eContext;
  let owner: LoggedInUser;

  const getVideo = (publicId: string) =>
    request(ctx.app.getHttpServer()).get(`/videos/${publicId}`);

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  }, 30000);

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetVideosState(ctx);
    owner = await createLoggedInUser(ctx, 'owner@example.com');
  });

  // 1. Resolver vídeo pela URL única

  it('retorna-video-ready-sem-token', async () => {
    const video = await seedVideo(ctx, owner.channel, {
      status: VideoStatus.READY,
      withThumbnail: true,
    });
    const calledAt = Date.now();

    const res = await getVideo(video.public_id).expect(200);

    const body = res.body as VideoResponseDto;
    expect(body).toMatchObject({
      publicId: video.public_id,
      title: 'Seeded video',
      status: 'ready',
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrate: 5000000,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      size: 1024,
      contentType: 'video/mp4',
      filename: 'seeded.mp4',
    });
    expect(typeof body.createdAt).toBe('string');
    for (const key of [
      'id',
      'uploadId',
      'upload_id',
      'channelId',
      'channel_id',
      'metadata',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    const ttl = Date.parse(body.thumbnail!.expiresAt) - calledAt;
    expect(ttl).toBeGreaterThanOrEqual(SIX_HOURS_MS - MINUTE_MS);
    expect(ttl).toBeLessThanOrEqual(SIX_HOURS_MS + MINUTE_MS);

    const thumbnail = await fetch(body.thumbnail!.url);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('retorna-draft-sem-metadados', async () => {
    const init = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Draft',
        filename: 'draft.mp4',
        size: 1024,
        contentType: 'video/mp4',
      })
      .expect(201);

    const res = await getVideo(
      (init.body as InitiateUploadResult).publicId,
    ).expect(200);

    expect(res.body).toMatchObject({
      status: 'draft',
      durationSeconds: null,
      width: null,
      videoCodec: null,
      thumbnail: null,
    });
  });

  it('retorna-failure-reason-de-video-failed', async () => {
    const video = await seedVideo(ctx, owner.channel, {
      status: VideoStatus.FAILED,
      failureReason: 'unreadable_media',
    });

    const res = await getVideo(video.public_id).expect(200);

    expect(res.body).toMatchObject({
      status: 'failed',
      failureReason: 'unreadable_media',
    });
  });

  it('retorna-404-para-public-id-inexistente', async () => {
    const res = await getVideo('inexistente').expect(404);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });
});
