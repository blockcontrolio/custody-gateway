import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyProvider } from './key-provider.abstract.js';
import { InMemoryKeyProvider } from './in-memory-key-provider.js';
import { PostgresKeyProvider } from './postgres-key-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Global()
@Module({
  providers: [
    {
      provide: KeyProvider,
      useFactory: (config: ConfigService, prisma: PrismaService) => {
        const masterKey = config.get<string>('KEY_ENCRYPTION_MASTER_KEY');
        if (masterKey && masterKey.length === 64) {
          return new PostgresKeyProvider(prisma, config);
        }
        return new InMemoryKeyProvider(config);
      },
      inject: [ConfigService, PrismaService],
    },
  ],
  exports: [KeyProvider],
})
export class KeyProviderModule {}
