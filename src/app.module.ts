import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module.js';
import { KeyProviderModule } from './key-provider/index.js';
import { RepositoryModule } from './repository/repository.module.js';
import { AccountModule } from './account/index.js';
import { ClearNodeModule } from './clear-node/clear-node.module.js';
import { YellowModule } from './yellow/yellow.module.js';
import { HealthModule } from './health/health.module.js';
import { CustodyModule } from './custody/custody.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    KeyProviderModule,
    RepositoryModule,
    AccountModule,
    ClearNodeModule,
    YellowModule,
    HealthModule,
    CustodyModule,
  ],
})
export class AppModule {}
