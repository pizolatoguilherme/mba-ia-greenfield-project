import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadPartsException,
  VideoAccessDeniedException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import type { MockedMethods } from '../test/mocked-methods';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.queue';
import { VideosService } from './videos.service';

const OWNER_ID = 'owner-user-id';

function makeVideo(status: VideoStatus): Video {
  const channel = new Channel();
  channel.id = 'channel-id';
  channel.user_id = OWNER_ID;

  const video = new Video();
  video.id = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
  video.public_id = 'abcDEF12_-x';
  video.channel_id = channel.id;
  video.channel = channel;
  video.status = status;
  video.upload_id = 'upload-id';
  return video;
}

describe('VideosService', () => {
  let videoRepository: MockedMethods<Repository<Video>>;
  let storageService: MockedMethods<StorageService>;
  let processingQueue: MockedMethods<Queue>;
  let service: VideosService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOne: jest.fn(), update: jest.fn() },
        },
        { provide: ChannelsService, useValue: {} },
        {
          provide: StorageService,
          useValue: {
            videosBucket: 'videos',
            completeMultipartUpload: jest.fn(),
            headObject: jest.fn(),
            deleteObject: jest.fn(),
          },
        },
        { provide: storageConfig.KEY, useValue: {} },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
    processingQueue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  describe('findOwnedDraft', () => {
    it('should return the video when the caller owns a draft', async () => {
      const video = makeVideo(VideoStatus.DRAFT);
      videoRepository.findOne.mockResolvedValue(video);

      await expect(
        service.findOwnedDraft(video.public_id, OWNER_ID),
      ).resolves.toBe(video);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: video.public_id },
        relations: { channel: true },
      });
    });

    it('should throw VIDEO_NOT_FOUND when no video matches', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedDraft('AAAAAAAAAAA', OWNER_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it("should throw VIDEO_ACCESS_DENIED for another user's video", async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo(VideoStatus.DRAFT));

      await expect(
        service.findOwnedDraft('abcDEF12_-x', 'someone-else'),
      ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should throw VIDEO_NOT_DRAFT when status is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(makeVideo(status));

        await expect(
          service.findOwnedDraft('abcDEF12_-x', OWNER_ID),
        ).rejects.toBeInstanceOf(VideoNotDraftException);
      },
    );

    it('should check ownership before status', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo(VideoStatus.PROCESSING),
      );

      await expect(
        service.findOwnedDraft('abcDEF12_-x', 'someone-else'),
      ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    });
  });

  describe('completeUpload', () => {
    const TEN_GIB = 10737418240;
    const parts = [{ partNumber: 1, etag: '"etag-1"' }];

    function s3Error(name: string): Error {
      return Object.assign(new Error(name), { name });
    }

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(makeVideo(VideoStatus.DRAFT));
    });

    it('should delete the object, mark the video failed and throw VIDEO_TOO_LARGE above 10 GiB', async () => {
      const video = makeVideo(VideoStatus.DRAFT);
      storageService.headObject.mockResolvedValue({
        contentLength: TEN_GIB + 1,
      });

      await expect(
        service.completeUpload(video.public_id, OWNER_ID, { parts }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos',
        `${video.id}/source`,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: video.id },
        { status: VideoStatus.FAILED, failure_reason: 'size_exceeded' },
      );
      expect(processingQueue.add).not.toHaveBeenCalled();
    });

    it('should accept an object of exactly 10 GiB', async () => {
      storageService.headObject.mockResolvedValue({ contentLength: TEN_GIB });

      await expect(
        service.completeUpload('abcDEF12_-x', OWNER_ID, { parts }),
      ).resolves.toEqual({
        publicId: 'abcDEF12_-x',
        status: VideoStatus.PROCESSING,
      });
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });

    it.each(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'])(
      'should map the storage error %s to INVALID_UPLOAD_PARTS',
      async (name) => {
        storageService.completeMultipartUpload.mockRejectedValue(s3Error(name));

        await expect(
          service.completeUpload('abcDEF12_-x', OWNER_ID, { parts }),
        ).rejects.toBeInstanceOf(InvalidUploadPartsException);
        expect(videoRepository.update).not.toHaveBeenCalled();
        expect(processingQueue.add).not.toHaveBeenCalled();
      },
    );

    it('should rethrow other storage errors unchanged', async () => {
      const error = s3Error('InternalError');
      storageService.completeMultipartUpload.mockRejectedValue(error);

      await expect(
        service.completeUpload('abcDEF12_-x', OWNER_ID, { parts }),
      ).rejects.toBe(error);
    });

    it('should persist processing before enqueuing the job with jobId = videoId', async () => {
      const video = makeVideo(VideoStatus.DRAFT);
      storageService.headObject.mockResolvedValue({ contentLength: 1024 });
      const calls: string[] = [];
      videoRepository.update.mockImplementation(() => {
        calls.push('update');
        return Promise.resolve({ affected: 1, raw: [], generatedMaps: [] });
      });
      processingQueue.add.mockImplementation(() => {
        calls.push('enqueue');
        return Promise.resolve({} as never);
      });

      await service.completeUpload(video.public_id, OWNER_ID, { parts });

      expect(calls).toEqual(['update', 'enqueue']);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: video.id },
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(processingQueue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: video.id },
        {
          jobId: video.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30000 },
        },
      );
    });
  });
});
