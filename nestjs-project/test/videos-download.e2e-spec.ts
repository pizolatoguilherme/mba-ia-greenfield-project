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

describe('videos-download', () => {
  let ctx: VideosE2eContext;
  let owner: LoggedInUser;

  const download = (publicId: string) =>
    request(ctx.app.getHttpServer()).get(`/videos/${publicId}/download`);

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

  it('baixa-com-nome-original', async () => {
    const video = await seedVideo(ctx, owner.channel, {
      status: VideoStatus.READY,
      filename: 'meu-video.mp4',
      source: Buffer.alloc(8192, 2),
    });
    const calledAt = Date.now();

    const res = await download(video.public_id).expect(200);

    const body = res.body as SignedUrlDto;
    const ttl = Date.parse(body.expiresAt) - calledAt;
    expect(ttl).toBeGreaterThanOrEqual(SIX_HOURS_MS - MINUTE_MS);
    expect(ttl).toBeLessThanOrEqual(SIX_HOURS_MS + MINUTE_MS);

    const file = await fetch(body.url);
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe(8192);
    const disposition = file.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="meu-video.mp4"');
  });

  it('sanitiza-filename-malicioso', async () => {
    const video = await seedVideo(ctx, owner.channel, {
      status: VideoStatus.READY,
      filename: '../a"b.mp4',
      source: Buffer.alloc(16, 3),
    });

    const res = await download(video.public_id).expect(200);
    const file = await fetch((res.body as SignedUrlDto).url);

    const disposition = file.headers.get('content-disposition') ?? '';
    const name = /filename="([^"]*)"/.exec(disposition)?.[1];
    expect(name).toBe('ab.mp4');
    expect(disposition).not.toContain('../');
  });

  it('rejeita-video-fora-de-ready', async () => {
    const video = await seedVideo(ctx, owner.channel, {
      status: VideoStatus.PROCESSING,
    });

    const res = await download(video.public_id).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');
  });
});
