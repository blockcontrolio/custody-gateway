import { Module } from '@nestjs/common';
import { CustodyService } from './custody.service.js';

@Module({
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}
