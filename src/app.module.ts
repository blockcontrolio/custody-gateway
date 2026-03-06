import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { KeyProviderModule } from './key-provider';
import { RepositoryModule } from './repository/repository.module';
import { AccountModule } from './account';
import { ClearNodeModule } from './clear-node/clear-node.module';
import { YellowModule } from './yellow/yellow.module';
import { HealthModule } from './health/health.module';
import { CustodyModule } from './custody/custody.module';

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
