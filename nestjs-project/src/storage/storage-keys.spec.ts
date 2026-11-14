import { autoThumbnailKey, videoSourceKey } from './storage-keys';

describe('storage keys', () => {
  const videoId = '3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b';

  it('should key the source video by the video id', () => {
    expect(videoSourceKey(videoId)).toBe(`${videoId}/source`);
  });

  it('should key the automatic thumbnail by the video id', () => {
    expect(autoThumbnailKey(videoId)).toBe(`${videoId}/auto.jpg`);
  });

  it.each(['../../etc/passwd', 'clip.mp4', 'a/b', ''])(
    'should reject a non-UUID id such as %p so filenames never reach a key',
    (value) => {
      expect(() => videoSourceKey(value)).toThrow('Invalid video id');
      expect(() => autoThumbnailKey(value)).toThrow('Invalid video id');
    },
  );
});
