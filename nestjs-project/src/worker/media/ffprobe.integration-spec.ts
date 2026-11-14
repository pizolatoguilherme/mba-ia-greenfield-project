import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { videoSourceKey } from '../../storage/storage-keys';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { generateTestVideo } from '../../test/video-fixtures';
import { probeMedia } from './ffprobe';
import { UnreadableMediaError } from './unreadable-media.error';

describe('probeMedia (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;

  async function uploadAndSign(body: Buffer): Promise<string> {
    const key = videoSourceKey(randomUUID());
    await storage.putObject(storage.videosBucket, key, body, 'video/mp4');
    return storage.signGetObject(storage.videosBucket, key, {
      expiresIn: 300,
      audience: 'internal',
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init();
    storage = moduleRef.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should read format and streams from a presigned URL', async () => {
    const url = await uploadAndSign(
      await generateTestVideo({ withAudio: true }),
    );

    const probe = await probeMedia(url);

    expect(Number(probe.format?.duration)).toBeGreaterThan(1.5);
    expect(probe.format?.format_name).toContain('mp4');
    const video = probe.streams?.find((s) => s.codec_type === 'video');
    expect(video).toMatchObject({
      codec_name: 'h264',
      width: 320,
      height: 240,
    });
    expect(probe.streams?.some((s) => s.codec_type === 'audio')).toBe(true);
  }, 30000);

  it('should throw UnreadableMediaError for bytes that are not media', async () => {
    const url = await uploadAndSign(randomBytes(64 * 1024));

    await expect(probeMedia(url)).rejects.toBeInstanceOf(UnreadableMediaError);
  }, 30000);
});
