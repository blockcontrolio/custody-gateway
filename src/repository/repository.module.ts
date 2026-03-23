import { Global, Module } from '@nestjs/common';
import { SessionRepository } from './session.repository.js';
import { InvitationRepository } from './invitation.repository.js';
import { WalletRepository } from './wallet.repository.js';
import { KeyRepository } from './key.repository.js';

@Global()
@Module({
  providers: [SessionRepository, InvitationRepository, WalletRepository, KeyRepository],
  exports: [SessionRepository, InvitationRepository, WalletRepository, KeyRepository],
})
export class RepositoryModule {}
