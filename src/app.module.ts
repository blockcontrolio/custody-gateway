import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeyProviderModule } from './key-provider';
import { PrismaModule } from './prisma/prisma.module';
import { RepositoryModule } from './repository/repository.module';
import { ClearNodeModule } from './clear-node/clear-node.module';
import { YellowModule } from './yellow/yellow.module';
import { HealthModule } from './health/health.module';
import { CustodyModule } from './custody/custody.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    KeyProviderModule,
    PrismaModule,
    RepositoryModule,
    ClearNodeModule,
    YellowModule,
    HealthModule,
    CustodyModule,
  ],
})
export class AppModule {}
