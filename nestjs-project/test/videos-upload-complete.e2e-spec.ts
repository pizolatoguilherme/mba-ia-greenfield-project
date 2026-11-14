import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { videoSourceKey } from '../src/storage/storage-keys';
import { StorageService } from '../src/storage/storage.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.queue';
import type {
  CompleteUploadResult,
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
const LAST_PART_SIZE = 4194304;
const TOTAL_SIZE = PART_SIZE + LAST_PART_SIZE; // 20971520

describe('videos-upload-complete', () => {
  let ctx: VideosE2eContext;
  let queue: Queue;
  let owner: LoggedInUser;
  let publicId: string;
  let parts: { partNumber: number; etag: string }[];

  const complete = (token: string, body: object) =>
    request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const findVideo = (): Promise<Video> =>
    ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
    queue = ctx.app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetVideosState(ctx);
    await queue.obliterate({ force: true });
    owner = await createLoggedInUser(ctx, 'owner@example.com');

    const init = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Clip',
        filename: 'clip.mp4',
        size: TOTAL_SIZE,
        contentType: 'video/mp4',
      })
      .expect(201);
    publicId = (init.body as InitiateUploadResult).publicId;

    const signed = await request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1, 2] })
      .expect(200);
    parts = [];
    for (const { partNumber, url } of (signed.body as SignPartUrlsResult)
      .parts) {
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(partNumber === 1 ? PART_SIZE : LAST_PART_SIZE),
      });
      parts.push({ partNumber, etag: put.headers.get('etag') as string });
    }
  });

  // 1. Completar upload e enfileirar processamento

  it('completa-e-move-para-processing', async () => {
    const res = await complete(owner.accessToken, {
      parts: [...parts].sort((a, b) => b.partNumber - a.partNumber),
    }).expect(202);

    expect(res.body as CompleteUploadResult).toEqual({
      publicId,
      status: 'processing',
    });

    const video = await findVideo();
    const storage = ctx.app.get(StorageService);
    await expect(
      storage.headObject(storage.videosBucket, videoSourceKey(video.id)),
    ).resolves.toEqual({ contentLength: TOTAL_SIZE });

    const job = await queue.getJob(video.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: video.id });
    expect(video.status).toBe(VideoStatus.PROCESSING);
  });

  it('segundo-complete-nao-cria-outro-job', async () => {
    await complete(owner.accessToken, { parts }).expect(202);

    const res = await complete(owner.accessToken, { parts }).expect(409);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_DRAFT');
    await expect(queue.count()).resolves.toBe(1);
  });

  // 2. Rejeitar conclusão inválida

  it('rejeita-etag-divergente', async () => {
    const res = await complete(owner.accessToken, {
      parts: parts.map((p) =>
        p.partNumber === 1 ? { ...p, etag: '"0000"' } : p,
      ),
    }).expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('INVALID_UPLOAD_PARTS');
    expect((await findVideo()).status).toBe(VideoStatus.DRAFT);
    await expect(queue.count()).resolves.toBe(0);
  });

  it('nega-acesso-a-outro-usuario', async () => {
    const other = await createLoggedInUser(ctx, 'other@example.com');

    const res = await complete(other.accessToken, { parts }).expect(403);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_ACCESS_DENIED');
    expect((await findVideo()).status).toBe(VideoStatus.DRAFT);
  });
});
