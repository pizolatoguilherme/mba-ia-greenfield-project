import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT as string,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT as string,
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY as string,
  secretKey: process.env.S3_SECRET_KEY as string,
  videosBucket: process.env.S3_VIDEOS_BUCKET || 'videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET || 'thumbnails',
  partSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || String(16 * 1024 * 1024),
    10,
  ),
  partUrlTtlSeconds: parseInt(
    process.env.UPLOAD_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  deliveryUrlTtlSeconds: parseInt(
    process.env.DELIVERY_URL_TTL_SECONDS || '21600',
    10,
  ),
  abandonAfterHours: parseInt(
    process.env.UPLOAD_ABANDON_AFTER_HOURS || '24',
    10,
  ),
}));
