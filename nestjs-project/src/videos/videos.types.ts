import type { VideoStatus } from './entities/video.entity';

export interface InitiateUploadResult {
  publicId: string;
  title: string;
  status: VideoStatus;
  partSize: number;
  partCount: number;
}

export interface SignedPartUrl {
  partNumber: number;
  url: string;
}

export interface SignPartUrlsResult {
  parts: SignedPartUrl[];
  expiresAt: string;
}

export interface UploadedPartsResult {
  parts: { partNumber: number; etag: string; size: number }[];
}

export interface CompleteUploadResult {
  publicId: string;
  status: VideoStatus;
}
