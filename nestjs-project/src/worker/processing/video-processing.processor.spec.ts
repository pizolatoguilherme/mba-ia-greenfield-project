import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import type { MockedMethods } from '../../test/mocked-methods';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../../videos/videos.queue';
import { probeMedia } from '../media/ffprobe';
import { extractThumbnail } from '../media/thumbnail';
import { VideoProcessingProcessor } from './video-processing.processor';

jest.mock('../media/ffprobe', () => ({ probeMedia: jest.fn() }));
jest.mock('../media/thumbnail', () => ({ extractThumbnail: jest.fn() }));

const VIDEO_ID = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

function makeJob(attemptsMade: number, attempts = 3): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    opts: { attempts },
    attemptsMade,
    failedReason: 'boom',
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videoRepository: MockedMethods<Repository<Video>>;
  let storageService: MockedMethods<StorageService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOneBy: jest.fn(), update: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: {
            videosBucket: 'videos',
            thumbnailsBucket: 'thumbnails',
            signGetObject: jest.fn(),
            putObject: jest.fn(),
          },
        },
        { provide: storageConfig.KEY, useValue: { deliveryUrlTtlSeconds: 60 } },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
    jest.mocked(probeMedia).mockReset();
    jest.mocked(extractThumbnail).mockReset();
  });

  describe('process', () => {
    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
      'should be a no-op when the video is %s',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue({
          id: VIDEO_ID,
          status,
        } as Video);

        await processor.process(makeJob(0));

        expect(storageService.signGetObject).not.toHaveBeenCalled();
        expect(probeMedia).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
      },
    );

    it('should be a no-op when the video no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await processor.process(makeJob(0));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should persist metadata, store the thumbnail and only then mark ready', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        id: VIDEO_ID,
        status: VideoStatus.PROCESSING,
      } as Video);
      storageService.signGetObject.mockResolvedValue('http://minio:9000/x');
      jest.mocked(probeMedia).mockResolvedValue({
        format: { format_name: 'mp4', duration: '20' },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      });
      const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
      jest.mocked(extractThumbnail).mockResolvedValue(jpeg);
      const calls: string[] = [];
      videoRepository.update.mockImplementation((_where, values) => {
        calls.push(`update:${String((values as { status?: string }).status)}`);
        return Promise.resolve({ affected: 1, raw: [], generatedMaps: [] });
      });
      storageService.putObject.mockImplementation(() => {
        calls.push('put');
        return Promise.resolve();
      });

      await processor.process(makeJob(0));

      expect(storageService.signGetObject).toHaveBeenCalledWith(
        'videos',
        `${VIDEO_ID}/source`,
        { expiresIn: 60, audience: 'internal' },
      );
      expect(extractThumbnail).toHaveBeenCalledWith('http://minio:9000/x', 2);
      expect(storageService.putObject).toHaveBeenCalledWith(
        'thumbnails',
        `${VIDEO_ID}/auto.jpg`,
        jpeg,
        'image/jpeg',
      );
      expect(calls).toEqual(['update:undefined', 'put', 'update:ready']);
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { thumbnail_key: `${VIDEO_ID}/auto.jpg`, status: VideoStatus.READY },
      );
    });

    it('should not mark ready when thumbnail extraction fails (retryable)', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        id: VIDEO_ID,
        status: VideoStatus.PROCESSING,
      } as Video);
      storageService.signGetObject.mockResolvedValue('http://minio:9000/x');
      jest.mocked(probeMedia).mockResolvedValue({
        format: { duration: '10' },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      });
      const error = new Error('ffmpeg crashed');
      jest.mocked(extractThumbnail).mockRejectedValue(error);

      await expect(processor.process(makeJob(0))).rejects.toBe(error);

      expect(videoRepository.update).toHaveBeenCalledTimes(1);
      expect(storageService.putObject).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should mark failed / processing_error on the last attempt', async () => {
      await processor.onFailed(makeJob(3));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: 'processing_error' },
      );
    });

    it('should do nothing on an intermediate attempt', async () => {
      await processor.onFailed(makeJob(1));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});
