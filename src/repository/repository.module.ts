import { Global, Module } from '@nestjs/common';
import { SessionRepository } from './session.repository.js';
import { ChannelRepository } from './channel.repository.js';
import { SignedStateRepository } from './signed-state.repository.js';

@Global()
@Module({
  providers: [SessionRepository, ChannelRepository, SignedStateRepository],
  exports: [SessionRepository, ChannelRepository, SignedStateRepository],
})
export class RepositoryModule {}
