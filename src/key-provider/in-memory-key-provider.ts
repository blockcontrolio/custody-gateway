import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { KeyProvider } from './key-provider.abstract.js';

@Injectable()
export class InMemoryKeyProvider extends KeyProvider {
  private readonly logger = new Logger(InMemoryKeyProvider.name);
  private readonly keys = new Map<string, { key: Hex; address: Address }>();

  constructor(private readonly config: ConfigService) {
    super();
    this.seedFromEnv();
  }

  private seedFromEnv(): void {
    const keyA = this.config.get<string>('YELLOW_SIGNER_PRIVATE_KEY');
    if (keyA) this.importKey(keyA as Hex);

    const keyB = this.config.get<string>('YELLOW_SIGNER_PRIVATE_KEY_B');
    if (keyB) this.importKey(keyB as Hex);
  }

  private importKey(key: Hex): Address {
    const account = privateKeyToAccount(key);
    this.keys.set(account.address.toLowerCase(), {
      key,
      address: account.address,
    });
    this.logger.log(`Seeded key for ${account.address}`);
    return account.address;
  }

  getKey(address: Address): Hex | null {
    return this.keys.get(address.toLowerCase())?.key ?? null;
  }

  listAddresses(): Address[] {
    return Array.from(this.keys.values()).map((v) => v.address);
  }

  generateKey(): Address {
    const key = generatePrivateKey();
    return this.importKey(key);
  }
}
