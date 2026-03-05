import { Module, forwardRef } from '@nestjs/common';
import { ClearNodeModule } from '../clear-node/clear-node.module';
import { YellowAuthService } from './auth/yellow-auth.service';
import { YellowClientService } from './client/yellow-client.service';
import { YellowService } from './handler/yellow.service';
import { YellowParserService } from './parser/yellow-parser.service';
import { KeyProviderService } from './providers/key-provider.service';
import { RequestIdService } from './providers/request-id.service';
import { YellowController } from './yellow.controller';

@Module({
  imports: [forwardRef(() => ClearNodeModule)],
  controllers: [YellowController],
  providers: [
    KeyProviderService,
    RequestIdService,
    YellowParserService,
    YellowService,
    YellowAuthService,
    YellowClientService,
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
