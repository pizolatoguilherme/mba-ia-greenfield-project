import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import {
  bullRootModule,
  configRootModule,
  typeOrmRootModule,
} from './config/root-modules';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    configRootModule,
    typeOrmRootModule,
    bullRootModule,
    AuthModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
