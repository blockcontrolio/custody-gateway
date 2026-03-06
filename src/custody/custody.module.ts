import { Module } from '@nestjs/common';
import { CustodyService } from './custody.service';
import { CustodyController } from './custody.controller';

@Module({
  providers: [CustodyService],
  controllers: [CustodyController],
  exports: [CustodyService],
})
export class CustodyModule {}
