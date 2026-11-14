import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { SignedUrlDto } from '../src/videos/dto/video-response.dto';
import { VideoStatus } from '../src/videos/entities/video.entity';
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

describe('videos-stream', () => {
  let ctx: VideosE2eContext;
  let owner: LoggedInUser;

  const stream = (publicId: string) =>
    request(ctx.app.getHttpServer()).get(`/videos/${publicId}/stream`);

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

  it('assina-url-de-video-ready', async () => {
    const video = await seedVideo(ctx, owner.channel, {
      status: VideoStatus.READY,
      source: Buffer.alloc(8192, 1),
    });
    const calledAt = Date.now();

    const res = await stream(video.public_id).expect(200);

    const body = res.body as SignedUrlDto;
    const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT as string).host;
    expect(new URL(body.url).host).toBe(publicHost);
    const ttl = Date.parse(body.expiresAt) - calledAt;
    expect(ttl).toBeGreaterThanOrEqual(SIX_HOURS_MS - MINUTE_MS);
    expect(ttl).toBeLessThanOrEqual(SIX_HOURS_MS + MINUTE_MS);

    const ranged = await fetch(body.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-1023/8192');
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
  });

  it('rejeita-video-fora-de-ready', async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
    ]) {
      const video = await seedVideo(ctx, owner.channel, { status });

      const res = await stream(video.public_id).expect(409);

      expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');
    }
  });

  it('retorna-404-para-public-id-inexistente', async () => {
    const res = await stream('AAAAAAAAAAA').expect(404);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });
});
