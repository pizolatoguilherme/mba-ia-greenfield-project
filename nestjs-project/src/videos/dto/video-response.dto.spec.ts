import { Video, VideoStatus } from '../entities/video.entity';
import { VideoResponseDto } from './video-response.dto';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: '6f9619ff-8b86-4011-b42d-00c04fc964ff',
    public_id: 'abcDEF12_-x',
    channel_id: 'channel-id',
    title: 'Clip',
    filename: 'clip.mp4',
    size: 1073741824,
    content_type: 'video/mp4',
    status: VideoStatus.READY,
    failure_reason: null,
    upload_id: 'upload-id',
    thumbnail_key: 'thumb-key',
    last_activity_at: new Date('2026-11-14T10:00:00Z'),
    duration_seconds: 12.5,
    width: 1920,
    height: 1080,
    video_codec: 'h264',
    audio_codec: 'aac',
    bitrate: 5000000,
    container: 'mov,mp4',
    metadata: { format: {} },
    created_at: new Date('2026-11-14T10:00:00Z'),
    updated_at: new Date('2026-11-14T10:00:00Z'),
    ...overrides,
  });
}

describe('VideoResponseDto.fromEntity', () => {
  it('should map to camelCase fields', () => {
    const thumbnail = {
      url: 'http://x',
      expiresAt: '2026-11-14T16:00:00.000Z',
    };

    const dto = VideoResponseDto.fromEntity(makeVideo(), thumbnail);

    expect(dto).toEqual({
      publicId: 'abcDEF12_-x',
      title: 'Clip',
      status: 'ready',
      failureReason: null,
      filename: 'clip.mp4',
      size: 1073741824,
      contentType: 'video/mp4',
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrate: 5000000,
      container: 'mov,mp4',
      thumbnail,
      createdAt: '2026-11-14T10:00:00.000Z',
    });
  });

  it('should convert bigint strings from the driver to numbers', () => {
    const dto = VideoResponseDto.fromEntity(
      makeVideo({
        size: '10737418240' as unknown as number,
        bitrate: '5000000' as unknown as number,
      }),
      null,
    );

    expect(dto.size).toBe(10737418240);
    expect(dto.bitrate).toBe(5000000);
  });

  it('should keep null metadata fields as null', () => {
    const dto = VideoResponseDto.fromEntity(
      makeVideo({
        status: VideoStatus.DRAFT,
        duration_seconds: null,
        width: null,
        height: null,
        video_codec: null,
        audio_codec: null,
        bitrate: null,
        container: null,
        thumbnail_key: null,
      }),
      null,
    );

    expect(dto).toMatchObject({
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      bitrate: null,
      container: null,
      thumbnail: null,
    });
  });

  it('should omit internal fields', () => {
    const dto = VideoResponseDto.fromEntity(makeVideo(), null);

    for (const key of [
      'id',
      'uploadId',
      'upload_id',
      'channelId',
      'channel_id',
      'metadata',
      'thumbnailKey',
      'thumbnail_key',
    ]) {
      expect(dto).not.toHaveProperty(key);
    }
  });
});
