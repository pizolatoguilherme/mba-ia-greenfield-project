import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { VIDEO_MAINTENANCE_QUEUE } from './video-maintenance.queue';
import { VideoSweepService } from './video-sweep.service';

/** Runs the hourly sweep (TD-11) and logs how many videos were affected. */
@Processor(VIDEO_MAINTENANCE_QUEUE)
export class VideoMaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoMaintenanceProcessor.name);

  constructor(private readonly sweepService: VideoSweepService) {
    super();
  }

  async process(): Promise<void> {
    const abandoned = await this.sweepService.failAbandonedUploads(new Date());
    const requeued = await this.sweepService.requeueStuckProcessing();
    this.logger.log(
      `Sweep: ${abandoned} abandoned upload(s) failed, ${requeued} processing video(s) re-enqueued`,
    );
  }
}
