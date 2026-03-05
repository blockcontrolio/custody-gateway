import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createECDSAMessageSigner } from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import type { Hex } from 'viem';

@Injectable()
export class KeyProviderService {
  private readonly logger = new Logger(KeyProviderService.name);

  constructor(
    @Inject(ConfigService)
    private readonly configService: Pick<ConfigService, 'get'>,
  ) {}

  getSignerKey(): Hex | null {
    const key = this.configService.get<string>('YELLOW_SIGNER_PRIVATE_KEY');
    if (!key || !key.startsWith('0x') || key.length < 66) {
      return null;
    }
    this.logger.debug('Signer key accessed');
    return key as Hex;
  }

  isConfigured(): boolean {
    return this.getSignerKey() !== null;
  }

  createSigner(): MessageSigner | null {
    const key = this.getSignerKey();
    if (!key) return null;
    return createECDSAMessageSigner(key);
  }
}
