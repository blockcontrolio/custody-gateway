import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { KeyRepository } from '../repository/key.repository.js';
import { KeyProvider } from './key-provider.abstract.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * PostgreSQL-backed key provider with AES-256-GCM encryption.
 * All keys are loaded into an in-memory cache on startup.
 * On generate, the key is persisted to DB and added to cache.
 * Master key: 32-byte hex string from env `KEY_ENCRYPTION_MASTER_KEY`.
 */
@Injectable()
export class PostgresKeyProvider extends KeyProvider implements OnModuleInit {
  private readonly logger = new Logger(PostgresKeyProvider.name);
  private readonly cache = new Map<string, { key: Hex; address: Address }>();
  private readonly masterKey: Buffer;

  constructor(
    private readonly keyRepo: KeyRepository,
    private readonly config: ConfigService,
  ) {
    super();
    const masterKeyHex = this.config.get<string>('KEY_ENCRYPTION_MASTER_KEY');
    if (!masterKeyHex || masterKeyHex.length !== 64) {
      throw new Error(
        'KEY_ENCRYPTION_MASTER_KEY must be a 64-char hex string (32 bytes). ' +
          "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    this.masterKey = Buffer.from(masterKeyHex, 'hex');
  }

  async onModuleInit(): Promise<void> {
    await this.loadAllFromDb();
    await this.seedFromEnv();
  }

  /* ───── KeyProvider interface ───── */

  getKey(address: Address): Hex | null {
    return this.cache.get(address.toLowerCase())?.key ?? null;
  }

  listAddresses(): Address[] {
    return Array.from(this.cache.values()).map((v) => v.address);
  }

  async generateKey(): Promise<Address> {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    await this.persistKey(account.address, privateKey);
    this.cache.set(account.address.toLowerCase(), {
      key: privateKey,
      address: account.address,
    });
    this.logger.log(`Generated new key: ${account.address}`);
    return account.address;
  }

  /* ───── Crypto ───── */

  private encrypt(plaintext: string): { encrypted: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  private decrypt(encrypted: string, iv: string, tag: string): string {
    const decipher = crypto.createDecipheriv(ALGO, this.masterKey, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /* ───── DB operations ───── */

  private async persistKey(address: string, privateKey: Hex): Promise<void> {
    const { encrypted, iv, tag } = this.encrypt(privateKey);
    await this.keyRepo.upsert(address, encrypted, iv, tag);
  }

  private async loadAllFromDb(): Promise<void> {
    const rows = await this.keyRepo.findAll();
    for (const row of rows) {
      try {
        const privateKey = this.decrypt(row.encryptedKey, row.iv, row.tag) as Hex;
        this.cache.set(row.address.toLowerCase(), {
          key: privateKey,
          address: row.address as Address,
        });
      } catch (err) {
        this.logger.error(
          `Failed to decrypt key for ${row.address}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`Loaded ${this.cache.size} keys from DB`);
  }

  /**
   * Import env keys into DB if they don't exist yet (backward compat).
   */
  private async seedFromEnv(): Promise<void> {
    const envKeys = [
      this.config.get<string>('YELLOW_SIGNER_PRIVATE_KEY'),
      this.config.get<string>('YELLOW_SIGNER_PRIVATE_KEY_B'),
    ].filter(Boolean) as string[];

    for (const raw of envKeys) {
      const hex = raw as Hex;
      const account = privateKeyToAccount(hex);
      if (!this.cache.has(account.address.toLowerCase())) {
        await this.persistKey(account.address, hex);
        this.cache.set(account.address.toLowerCase(), {
          key: hex,
          address: account.address,
        });
        this.logger.log(`Seeded env key for ${account.address}`);
      }
    }
  }
}
