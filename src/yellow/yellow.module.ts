import { Module, forwardRef } from '@nestjs/common';
import { ClearNodeModule } from '../clear-node/clear-node.module.js';
import { CustodyModule } from '../custody/custody.module.js';
import { YellowAuthService } from './auth/yellow-auth.service.js';
import { YellowClientService } from './client/yellow-client.service.js';
import { YellowService } from './handler/yellow.service.js';
import { YellowParserService } from './parser/yellow-parser.service.js';
import { KeyProviderService } from './providers/key-provider.service.js';
import { RequestIdService } from './providers/request-id.service.js';
import { YellowController } from './yellow.controller.js';
import { InvitationRepository } from '../repository/invitation.repository.js';
import { ChannelFundingService } from '../custody/channel-funding.service.js';

@Module({
  imports: [forwardRef(() => ClearNodeModule), CustodyModule],
  controllers: [YellowController],
  providers: [
    KeyProviderService,
    RequestIdService,
    YellowParserService,
    YellowService,
    YellowAuthService,
    YellowClientService,
    InvitationRepository,
    ChannelFundingService,
  ],
  exports: [
    KeyProviderService,
    RequestIdService,
    YellowParserService,
    YellowService,
    YellowAuthService,
    YellowClientService,
  ],
})
export class YellowModule {}
