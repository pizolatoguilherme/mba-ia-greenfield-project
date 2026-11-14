import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videochan${n}`,
        user_id: user.id,
      }),
    );
  }

  function requiredFields(channelId: string): Partial<Video> {
    return {
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'My video',
      filename: 'clip.mp4',
      size: 1048576,
      content_type: 'video/mp4',
    };
  }

  it('should default status to draft and fill last_activity_at', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(requiredFields(channel.id)),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.last_activity_at).toBeInstanceOf(Date);
  });

  it('should leave failure, upload and metadata columns null', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(requiredFields(channel.id)),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found).toMatchObject({
      failure_reason: null,
      upload_id: null,
      thumbnail_key: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      bitrate: null,
      container: null,
      metadata: null,
    });
  });

  it('should round-trip bigint size and jsonb metadata', async () => {
    const channel = await createChannel();
    const tenGiB = 10737418240;

    const saved = await videoRepository.save(
      videoRepository.create({
        ...requiredFields(channel.id),
        size: tenGiB,
        bitrate: 5000000,
        metadata: { format: { format_name: 'mov,mp4' }, streams: [] },
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size).toBe(tenGiB);
    expect(found.bitrate).toBe(5000000);
    expect(found.metadata).toEqual({
      format: { format_name: 'mov,mp4' },
      streams: [],
    });
  });

  it('should enforce unique public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();

    await videoRepository.save(
      videoRepository.create({
        ...requiredFields(channel.id),
        public_id: publicId,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          ...requiredFields(channel.id),
          public_id: publicId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce the channel_id foreign key', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create(requiredFields(randomUUID())),
      ),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          ...requiredFields(channel.id),
          status: 'published' as VideoStatus,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the videos of a channel via the OneToMany relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(requiredFields(channel.id)),
    );

    const found = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: ['videos'],
    });

    expect(found.videos).toHaveLength(1);
    expect(found.videos[0].title).toBe('My video');
  });
});
