import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { videoSourceKey } from '../../storage/storage-keys';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { generateTestVideo, readJpegSize } from '../../test/video-fixtures';
import { extractThumbnail } from './thumbnail';

describe('extractThumbnail (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;

  async function uploadFixture(size: string): Promise<string> {
    const body = await generateTestVideo({ withAudio: false, size });
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

  it('should scale a 1920x1080 source down to a 1280x720 JPEG', async () => {
    const url = await uploadFixture('1920x1080');

    const image = await extractThumbnail(url, 0.2);

    expect(image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(readJpegSize(image)).toEqual({ width: 1280, height: 720 });
  }, 60000);

  it('should keep the width of a source narrower than 1280 px', async () => {
    const url = await uploadFixture('640x360');

    const image = await extractThumbnail(url, 0.2);

    expect(readJpegSize(image)).toEqual({ width: 640, height: 360 });
  }, 60000);
});
