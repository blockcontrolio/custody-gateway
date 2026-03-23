import { Module } from '@nestjs/common';
import { ClearNodeService } from './clear-node.service.js';
import { YellowModule } from '../yellow/yellow.module.js';

@Module({
  imports: [YellowModule],
  providers: [ClearNodeService],
  exports: [ClearNodeService],
})
export class ClearNodeModule {}
