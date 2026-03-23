import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ClearNodeModule } from '../clear-node/clear-node.module.js';
import { YellowModule } from '../yellow/yellow.module.js';

@Module({
  imports: [ClearNodeModule, YellowModule],
  controllers: [HealthController],
})
export class HealthModule {}
