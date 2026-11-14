import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import type {
  InitiateUploadResult,
  SignPartUrlsResult,
  UploadedPartsResult,
} from '../src/videos/videos.types';
import {
  bootstrapVideosApp,
  createLoggedInUser,
  resetVideosState,
  type LoggedInUser,
  type VideosE2eContext,
} from './videos-e2e.helpers';

const PART_SIZE = 16777216;

describe('videos-upload-parts', () => {
  let ctx: VideosE2eContext;
  let owner: LoggedInUser;
  let publicId: string;

  const listParts = (token: string) =>
    request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}/upload/parts`)
      .set('Authorization', `Bearer ${token}`);

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
        size: 3 * PART_SIZE,
        contentType: 'video/mp4',
      })
      .expect(201);
    publicId = (res.body as InitiateUploadResult).publicId;
  });

  // 1. Listar partes para retomada

  it('lista-vazia-logo-apos-init', async () => {
    const res = await listParts(owner.accessToken).expect(200);

    expect(res.body).toEqual({ parts: [] });
  });

  it('lista-somente-partes-enviadas', async () => {
    const signed = await request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1, 3] })
      .expect(200);
    const etags = new Map<number, string | null>();
    for (const { partNumber, url } of (signed.body as SignPartUrlsResult)
      .parts) {
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(PART_SIZE),
      });
      expect(put.status).toBe(200);
      etags.set(partNumber, put.headers.get('etag'));
    }

    const res = await listParts(owner.accessToken).expect(200);

    expect((res.body as UploadedPartsResult).parts).toEqual([
      { partNumber: 1, etag: etags.get(1), size: PART_SIZE },
      { partNumber: 3, etag: etags.get(3), size: PART_SIZE },
    ]);
  });

  // 2. Restringir acesso e estado

  it('nega-acesso-a-outro-usuario', async () => {
    const other = await createLoggedInUser(ctx, 'other@example.com');

    const res = await listParts(other.accessToken).expect(403);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_ACCESS_DENIED');
  });

  it('rejeita-video-fora-de-draft', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, { status: VideoStatus.READY });

    const res = await listParts(owner.accessToken).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_DRAFT');
  });
});
