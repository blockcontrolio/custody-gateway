import { Module, Global } from '@nestjs/common';
import { AccountService } from './account.service.js';
import { UserController } from './user.controller.js';
import { CustodyModule } from '../custody/custody.module.js';

@Global()
@Module({
  imports: [CustodyModule],
  controllers: [UserController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
