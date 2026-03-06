import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createECDSAMessageSigner } from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { KeyProvider } from '../../key-provider';

@Injectable()
export class KeyProviderService {
  private readonly logger = new Logger(KeyProviderService.name);
  private readonly defaultAddress: Address | null = null;

  constructor(
    private readonly keyProvider: KeyProvider,
    private readonly configService: ConfigService,
  ) {
    const key = this.configService.get<string>('YELLOW_SIGNER_PRIVATE_KEY');
    if (key?.startsWith('0x') && key.length >= 66) {
      this.defaultAddress = privateKeyToAccount(key as Hex).address;
    }
  }

  getSignerKey(): Hex | null {
    if (!this.defaultAddress) return null;
    const key = this.keyProvider.getKey(this.defaultAddress);
    if (key) this.logger.debug('Signer key accessed');
    return key;
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
