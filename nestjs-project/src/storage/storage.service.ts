import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListPartsCommandOutput,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface SignGetObjectOptions {
  expiresIn: number;
  /** Sets `Content-Disposition` on the response (e.g. download as attachment). */
  responseContentDisposition?: string;
  /**
   * `public` signs against S3_PUBLIC_ENDPOINT (URLs handed to clients);
   * `internal` signs against S3_ENDPOINT (URLs read by the worker).
   */
  audience: 'public' | 'internal';
}

/**
 * Single entry point to object storage (MinIO locally, S3 in production).
 * Two clients: the internal one talks to S3_ENDPOINT (Compose service name)
 * for every operation; the public one only signs URLs that clients reach via
 * S3_PUBLIC_ENDPOINT. Presigning is computed locally, so the public client
 * never needs to reach its own host.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const base = {
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    };
    this.client = new S3Client({ ...base, endpoint: config.endpoint });
    this.publicClient = new S3Client({
      ...base,
      endpoint: config.publicEndpoint,
    });
  }

  get videosBucket(): string {
    return this.config.videosBucket;
  }

  get thumbnailsBucket(): string {
    return this.config.thumbnailsBucket;
  }

  async onModuleInit(): Promise<void> {
    for (const bucket of [this.videosBucket, this.thumbnailsBucket]) {
      await this.ensureBucket(bucket);
    }
    await this.applyUploadCors(this.videosBucket);
  }

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for ${bucket}/${key}`);
    }
    return UploadId;
  }

  signUploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.partUrlTtlSeconds },
    );
  }

  async listParts(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    let page: ListPartsCommandOutput;
    do {
      page = await this.client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size ?? 0,
        });
      }
      marker = page.NextPartNumberMarker;
    } while (page.IsTruncated);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Returns the object size in bytes, or `null` when the object does not exist. */
  async headObject(
    bucket: string,
    key: string,
  ): Promise<{ contentLength: number } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return { contentLength: head.ContentLength ?? 0 };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  signGetObject(
    bucket: string,
    key: string,
    options: SignGetObjectOptions,
  ): Promise<string> {
    const client =
      options.audience === 'public' ? this.publicClient : this.client;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      if (!this.isNotFound(error)) throw error;
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      this.logger.log(`Created bucket ${bucket}`);
    } catch (error) {
      const name = (error as Error).name;
      // Another process (API vs worker) may have created it concurrently.
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw error;
      }
    }
  }

  /**
   * Browsers upload parts straight to storage, so the videos bucket must allow
   * cross-origin PUT/GET with Range and expose ETag. S3 accepts per-bucket CORS;
   * MinIO does not implement it (NotImplemented) and relies on its global
   * MINIO_API_CORS_ALLOW_ORIGIN setting instead (see compose.yaml).
   */
  private async applyUploadCors(bucket: string): Promise<void> {
    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET', 'PUT', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag', 'Content-Range', 'Content-Length'],
              },
            ],
          },
        }),
      );
    } catch (error) {
      if ((error as Error).name !== 'NotImplemented') throw error;
      this.logger.log(
        `Bucket CORS not supported by storage; relying on server-wide CORS for ${bucket}`,
      );
    }
  }

  private isNotFound(error: unknown): boolean {
    if (error instanceof S3ServiceException) {
      return (
        error.$metadata?.httpStatusCode === 404 ||
        error.name === 'NotFound' ||
        error.name === 'NoSuchKey' ||
        error.name === 'NoSuchBucket'
      );
    }
    return false;
  }
}
