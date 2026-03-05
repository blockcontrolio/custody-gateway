import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ClearNodeModule } from './clear-node/clear-node.module';
import { YellowModule } from './yellow/yellow.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ClearNodeModule,
    YellowModule,
    HealthModule,
  ],
})
export class AppModule {}
