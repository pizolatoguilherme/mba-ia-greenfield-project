import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video } from '../src/videos/entities/video.entity';
import type { InitiateUploadResult } from '../src/videos/videos.types';
import {
  bootstrapVideosApp,
  createLoggedInUser,
  resetVideosState,
  type LoggedInUser,
  type VideosE2eContext,
} from './videos-e2e.helpers';

describe('videos-create', () => {
  let ctx: VideosE2eContext;
  let owner: LoggedInUser;

  const validBody = {
    title: 'Meu vídeo',
    filename: 'clip.mp4',
    size: 1073741824,
    contentType: 'video/mp4',
  };

  const videoCount = (): Promise<number> =>
    ctx.dataSource.getRepository(Video).count();

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  }, 30000);

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetVideosState(ctx);
    owner = await createLoggedInUser(ctx, 'uploader@example.com');
  });

  // 1. Pré-cadastrar vídeo como rascunho ao iniciar o upload

  it('cria-draft-com-parametros-de-upload', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(validBody)
      .expect(201);

    const body = res.body as InitiateUploadResult;
    expect(body).toMatchObject({
      status: 'draft',
      partSize: 16777216,
      partCount: 64,
      title: 'Meu vídeo',
    });
    expect(body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);

    const video = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: body.publicId });
    expect(video).toMatchObject({
      status: 'draft',
      channel_id: owner.channel.id,
      title: 'Meu vídeo',
      filename: 'clip.mp4',
      size: 1073741824,
      content_type: 'video/mp4',
    });
    expect(video.upload_id).toEqual(expect.any(String));
  });

  // 2. Rejeitar inicialização inválida

  it('rejeita-content-type-fora-da-allowlist', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ ...validBody, contentType: 'video/avi' })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    await expect(videoCount()).resolves.toBe(0);
  });

  it('rejeita-tamanho-acima-de-10-gib', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ ...validBody, size: 10737418241 })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    await expect(videoCount()).resolves.toBe(0);
  });

  it('rejeita-sem-titulo', async () => {
    const withoutTitle: Partial<typeof validBody> = { ...validBody };
    delete withoutTitle.title;

    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(withoutTitle)
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
  });

  it('rejeita-sem-token', async () => {
    await request(ctx.app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);

    await expect(videoCount()).resolves.toBe(0);
  });
});
