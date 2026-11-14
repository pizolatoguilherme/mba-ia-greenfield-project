import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  bullRootModule,
  configRootModule,
  typeOrmRootModule,
} from '../config/root-modules';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.queue';
import { VIDEO_MAINTENANCE_QUEUE } from './maintenance/video-maintenance.queue';
import { VideoMaintenanceProcessor } from './maintenance/video-maintenance.processor';
import { VideoMaintenanceScheduler } from './maintenance/video-maintenance.scheduler';
import { VideoSweepService } from './maintenance/video-sweep.service';
import { VideoProcessingProcessor } from './processing/video-processing.processor';

/**
 * Root module of the video worker process (TD-06): same codebase and config
 * as the API, but no HTTP layer. Queue processors are registered here.
 * Channel and User are registered because Video's relations reference them.
 */
@Module({
  imports: [
    configRootModule,
    typeOrmRootModule,
    bullRootModule,
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
    StorageModule,
  ],
  providers: [
    VideoProcessingProcessor,
    VideoSweepService,
    VideoMaintenanceScheduler,
    VideoMaintenanceProcessor,
  ],
})
export class WorkerModule {}
