import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';

/**
 * Global infrastructure shared by the API (`AppModule`) and the video worker
 * (`WorkerModule`), so both processes read the same validated env and connect
 * to the same database and Redis.
 */
export const configRootModule = ConfigModule.forRoot({
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    swaggerConfig,
    storageConfig,
    queueConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
});

export const typeOrmRootModule = TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [databaseConfig.KEY],
  useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  }),
});

export const bullRootModule = BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (queue: ConfigType<typeof queueConfig>) => ({
    connection: { host: queue.host, port: queue.port },
  }),
});
