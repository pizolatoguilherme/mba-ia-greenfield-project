import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import type {
  InitiateUploadResult,
  SignPartUrlsResult,
} from '../src/videos/videos.types';
import {
  bootstrapVideosApp,
  createLoggedInUser,
  resetVideosState,
  type LoggedInUser,
  type VideosE2eContext,
} from './videos-e2e.helpers';

const PART_SIZE = 16777216;

describe('videos-upload-part-urls', () => {
  let ctx: VideosE2eContext;
  let owner: LoggedInUser;
  let publicId: string;

  const signParts = (token: string, id: string, partNumbers: number[]) =>
    request(ctx.app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers });

  const findVideo = (): Promise<Video> =>
    ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  }, 30000);

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetVideosState(ctx);
    owner = await createLoggedInUser(ctx, 'owner@example.com');
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Clip',
        filename: 'clip.mp4',
        size: 2 * PART_SIZE,
        contentType: 'video/mp4',
      })
      .expect(201);
    publicId = (res.body as InitiateUploadResult).publicId;
  });

  // 1. Assinar URLs de partes para o dono

  it('assina-urls-e-aceita-put-da-parte', async () => {
    const calledAt = Date.now();

    const res = await signParts(owner.accessToken, publicId, [1, 2]).expect(
      200,
    );

    const body = res.body as SignPartUrlsResult;
    expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT as string).host;
    for (const part of body.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }
    const ttlMs = Date.parse(body.expiresAt) - calledAt;
    expect(ttlMs).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(61 * 60 * 1000);

    const put = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(PART_SIZE),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('atualiza-last-activity-at', async () => {
    const before = (await findVideo()).last_activity_at;
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await signParts(owner.accessToken, publicId, [1]).expect(200);

    const after = (await findVideo()).last_activity_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('rejeita-parte-acima-do-part-count', async () => {
    const res = await signParts(owner.accessToken, publicId, [3]).expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('INVALID_PART_NUMBER');
  });

  // 2. Restringir acesso e estado

  it('nega-acesso-a-outro-usuario', async () => {
    const other = await createLoggedInUser(ctx, 'other@example.com');

    const res = await signParts(other.accessToken, publicId, [1]).expect(403);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_ACCESS_DENIED');
  });

  it('retorna-404-para-public-id-inexistente', async () => {
    const res = await signParts(owner.accessToken, 'AAAAAAAAAAA', [1]).expect(
      404,
    );

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });

  it('rejeita-video-fora-de-draft', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, { status: VideoStatus.PROCESSING });

    const res = await signParts(owner.accessToken, publicId, [1]).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_DRAFT');
  });
});
