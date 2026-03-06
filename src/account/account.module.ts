import { Module, Global } from '@nestjs/common';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';

@Global()
@Module({
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
