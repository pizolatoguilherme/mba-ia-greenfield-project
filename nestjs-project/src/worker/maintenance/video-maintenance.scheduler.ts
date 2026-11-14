import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  SWEEP_ABANDONED_UPLOADS_JOB,
  SWEEP_INTERVAL_MS,
  VIDEO_MAINTENANCE_QUEUE,
} from './video-maintenance.queue';

/**
 * Registers the hourly sweep at worker bootstrap. `upsertJobScheduler` is
 * idempotent, so restarts keep a single scheduler (TD-11).
 */
@Injectable()
export class VideoMaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      SWEEP_ABANDONED_UPLOADS_JOB,
      { every: SWEEP_INTERVAL_MS },
      { name: SWEEP_ABANDONED_UPLOADS_JOB, data: {} },
    );
  }
}
