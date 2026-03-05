import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ClearNodeModule } from '../clear-node/clear-node.module';
import { YellowModule } from '../yellow/yellow.module';

@Module({
  imports: [ClearNodeModule, YellowModule],
  controllers: [HealthController],
})
export class HealthModule {}
