import { Module, Global } from '@nestjs/common';
import { KeyProvider } from './key-provider.abstract';
import { InMemoryKeyProvider } from './in-memory-key-provider';

@Global()
@Module({
  providers: [
    {
      provide: KeyProvider,
      useClass: InMemoryKeyProvider,
    },
  ],
  exports: [KeyProvider],
})
export class KeyProviderModule {}
