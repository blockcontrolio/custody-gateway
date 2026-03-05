import { Global, Module } from '@nestjs/common';
import { SessionRepository } from './session.repository';
import { ChannelRepository } from './channel.repository';
import { SignedStateRepository } from './signed-state.repository';

@Global()
@Module({
  providers: [SessionRepository, ChannelRepository, SignedStateRepository],
  exports: [SessionRepository, ChannelRepository, SignedStateRepository],
})
export class RepositoryModule {}
