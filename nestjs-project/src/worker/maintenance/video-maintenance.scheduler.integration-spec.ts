import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { VIDEO_MAINTENANCE_QUEUE } from './video-maintenance.queue';
import { VideoMaintenanceScheduler } from './video-maintenance.scheduler';

describe('VideoMaintenanceScheduler (integration)', () => {
  const openModules: TestingModule[] = [];

  async function bootstrap(): Promise<Queue> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({ name: VIDEO_MAINTENANCE_QUEUE }),
      ],
      providers: [VideoMaintenanceScheduler],
    }).compile();
    openModules.push(moduleRef);
    await moduleRef.init();
    return moduleRef.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
  }

  afterEach(async () => {
    await Promise.all(openModules.splice(0).map((m) => m.close()));
  });

  it('should register sweep-abandoned-uploads every 3600000 ms, once across bootstraps', async () => {
    const queue = await bootstrap();
    await queue.obliterate({ force: true });
    const first = await bootstrap();

    const afterFirst = await first.getJobSchedulers();
    await bootstrap();
    const afterSecond = await first.getJobSchedulers();

    const sweeps = (list: typeof afterFirst) =>
      list.filter((s) => s.key === 'sweep-abandoned-uploads');
    expect(sweeps(afterFirst)).toHaveLength(1);
    expect(sweeps(afterFirst)[0].every).toBe(3600000);
    expect(sweeps(afterSecond)).toHaveLength(1);
    await expect(first.getJobSchedulersCount()).resolves.toBe(1);
  });
});
