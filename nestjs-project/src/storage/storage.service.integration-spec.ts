import { randomBytes, randomUUID } from 'node:crypto';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { videoSourceKey } from './storage-keys';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MiB = 1024 * 1024;

// URLs are fetched from inside the container, so the "public" endpoint used by
// this suite must be the Compose service name (signatures bind to the host).
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

describe('StorageService (integration, real MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(storage.videosBucket, key);
    }
    await moduleRef.close();
  });

  const newKey = () => {
    const key = videoSourceKey(randomUUID());
    createdKeys.push(key);
    return key;
  };

  const putPart = async (url: string, body: Buffer): Promise<string> => {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  };

  describe('bootstrap', () => {
    it('should create the videos and thumbnails buckets on init', async () => {
      const client = new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY!,
          secretAccessKey: process.env.S3_SECRET_KEY!,
        },
      });
      for (const bucket of [storage.videosBucket, storage.thumbnailsBucket]) {
        await expect(
          client.send(new HeadBucketCommand({ Bucket: bucket })),
        ).resolves.toBeDefined();
      }
    });

    it('should keep the buckets private to anonymous reads', async () => {
      const key = newKey();
      await storage.putObject(
        storage.videosBucket,
        key,
        Buffer.from('secret'),
        'video/mp4',
      );
      const response = await fetch(
        `${process.env.S3_ENDPOINT}/${storage.videosBucket}/${key}`,
      );
      expect(response.status).toBe(403);
    });

    it('should be idempotent when the buckets already exist', async () => {
      await expect(storage.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('presigned multipart upload', () => {
    it('should assemble parts PUT to presigned URLs into one object', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(
        storage.videosBucket,
        key,
        'video/mp4',
      );
      const part1 = randomBytes(5 * MiB);
      const part2 = randomBytes(1024);

      const etag1 = await putPart(
        await storage.signUploadPart(storage.videosBucket, key, uploadId, 1),
        part1,
      );
      const etag2 = await putPart(
        await storage.signUploadPart(storage.videosBucket, key, uploadId, 2),
        part2,
      );

      const parts = await storage.listParts(
        storage.videosBucket,
        key,
        uploadId,
      );
      expect(parts).toEqual([
        { partNumber: 1, etag: etag1, size: part1.length },
        { partNumber: 2, etag: etag2, size: part2.length },
      ]);

      await storage.completeMultipartUpload(
        storage.videosBucket,
        key,
        uploadId,
        [
          { partNumber: 2, etag: etag2 },
          { partNumber: 1, etag: etag1 },
        ],
      );

      await expect(
        storage.headObject(storage.videosBucket, key),
      ).resolves.toEqual({ contentLength: part1.length + part2.length });
    });

    it('should list no parts for a freshly created upload', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(
        storage.videosBucket,
        key,
        'video/mp4',
      );
      await expect(
        storage.listParts(storage.videosBucket, key, uploadId),
      ).resolves.toEqual([]);
      await storage.abortMultipartUpload(storage.videosBucket, key, uploadId);
    });

    it('should make an aborted upload unknown to storage', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(
        storage.videosBucket,
        key,
        'video/mp4',
      );
      await storage.abortMultipartUpload(storage.videosBucket, key, uploadId);
      await expect(
        storage.listParts(storage.videosBucket, key, uploadId),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });
  });

  describe('presigned GET', () => {
    it('should serve a Range request with 206 Partial Content', async () => {
      const key = newKey();
      const body = randomBytes(8192);
      await storage.putObject(storage.videosBucket, key, body, 'video/mp4');

      const url = await storage.signGetObject(storage.videosBucket, key, {
        expiresIn: 60,
        audience: 'public',
      });
      const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/8192');
      const chunk = Buffer.from(await response.arrayBuffer());
      expect(chunk.equals(body.subarray(0, 1024))).toBe(true);
    });

    it('should apply ResponseContentDisposition to the response', async () => {
      const key = newKey();
      await storage.putObject(
        storage.videosBucket,
        key,
        Buffer.from('x'),
        'video/mp4',
      );
      const url = await storage.signGetObject(storage.videosBucket, key, {
        expiresIn: 60,
        audience: 'public',
        responseContentDisposition: 'attachment; filename="clip.mp4"',
      });
      const response = await fetch(url);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('should return null from headObject for a missing object', async () => {
      await expect(
        storage.headObject(storage.videosBucket, videoSourceKey(randomUUID())),
      ).resolves.toBeNull();
    });
  });

  describe('CORS', () => {
    it('should answer a browser preflight for a part PUT from another origin', async () => {
      const response = await fetch(
        `${process.env.S3_ENDPOINT}/${storage.videosBucket}/any-key`,
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:3001',
            'Access-Control-Request-Method': 'PUT',
          },
        },
      );
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:3001',
      );
    });

    it('should expose ETag to the browser on a cross-origin part PUT', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(
        storage.videosBucket,
        key,
        'video/mp4',
      );
      const url = await storage.signUploadPart(
        storage.videosBucket,
        key,
        uploadId,
        1,
      );
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.from('part')),
        headers: { Origin: 'http://localhost:3001' },
      });
      const exposed = (
        response.headers.get('access-control-expose-headers') ?? ''
      )
        .toLowerCase()
        .split(',')
        .map((h) => h.trim());
      expect(exposed).toContain('etag');
      await storage.abortMultipartUpload(storage.videosBucket, key, uploadId);
    });
  });

  describe('endpoint topology', () => {
    const signer = new StorageService({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKey: 'access',
      secretKey: 'secret',
      videosBucket: 'videos',
      thumbnailsBucket: 'thumbnails',
      partSizeBytes: 16 * MiB,
      partUrlTtlSeconds: 3600,
      deliveryUrlTtlSeconds: 21600,
      abandonAfterHours: 24,
    });

    it('should sign part URLs against the public endpoint with the part TTL', async () => {
      const url = new URL(await signer.signUploadPart('videos', 'k', 'u', 1));
      expect(url.host).toBe('localhost:9000');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    });

    it('should sign GET URLs against the endpoint of the requested audience', async () => {
      const pub = new URL(
        await signer.signGetObject('videos', 'k', {
          expiresIn: 21600,
          audience: 'public',
        }),
      );
      const internal = new URL(
        await signer.signGetObject('videos', 'k', {
          expiresIn: 21600,
          audience: 'internal',
        }),
      );
      expect(pub.host).toBe('localhost:9000');
      expect(internal.host).toBe('minio:9000');
    });
  });
});
