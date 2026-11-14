import type { FfprobeOutput } from './ffprobe';
import { mapProbeToMetadata } from './probe-mapper';
import { UnreadableMediaError } from './unreadable-media.error';

const videoStream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  pix_fmt: 'yuv420p',
  tags: { handler_name: 'VideoHandler' },
};
const audioStream = {
  index: 1,
  codec_type: 'audio',
  codec_name: 'aac',
  sample_rate: '48000',
  channels: 2,
};
const format = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '12.345000',
  bit_rate: '5000000',
  size: '7716000',
  tags: { encoder: 'Lavf' },
};

describe('mapProbeToMetadata', () => {
  it('should map a video with audio to the typed columns', () => {
    const result = mapProbeToMetadata({
      format,
      streams: [videoStream, audioStream],
    });

    expect(result).toMatchObject({
      duration_seconds: 12.345,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 5000000,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
  });

  it('should leave audio_codec null for a video without audio', () => {
    const result = mapProbeToMetadata({ format, streams: [videoStream] });

    expect(result.audio_codec).toBeNull();
    expect(result.video_codec).toBe('h264');
  });

  it('should throw UnreadableMediaError when there is no video stream', () => {
    expect(() =>
      mapProbeToMetadata({ format, streams: [audioStream] }),
    ).toThrow(UnreadableMediaError);
    expect(() => mapProbeToMetadata({})).toThrow(UnreadableMediaError);
  });

  it('should parse numeric fields given as strings and null out invalid ones', () => {
    const probe: FfprobeOutput = {
      format: {
        format_name: 'matroska,webm',
        duration: '3.5',
        bit_rate: 'N/A',
      },
      streams: [{ ...videoStream, width: '640' as unknown as number }],
    };

    const result = mapProbeToMetadata(probe);

    expect(result.duration_seconds).toBe(3.5);
    expect(result.width).toBe(640);
    expect(result.bitrate).toBeNull();
  });

  it('should keep a trimmed summary in metadata without tags', () => {
    const result = mapProbeToMetadata({
      format,
      streams: [videoStream, audioStream],
    });

    expect(result.metadata).toEqual({
      format: {
        format_name: format.format_name,
        duration: format.duration,
        bit_rate: format.bit_rate,
        size: format.size,
      },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          pix_fmt: 'yuv420p',
        },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          sample_rate: '48000',
          channels: 2,
        },
      ],
    });
  });
});
