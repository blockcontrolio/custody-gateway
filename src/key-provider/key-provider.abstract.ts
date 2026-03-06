import type { Address, Hex } from 'viem';

/**
 * Abstract key provider — can be backed by InMemory, Fireblocks, Utila, DFNS etc.
 */
export abstract class KeyProvider {
  /** Get private key for an address. Returns null if not managed. */
  abstract getKey(address: Address): Hex | null;

  /** List all managed addresses. */
  abstract listAddresses(): Address[];

  /** Generate a new key pair, store it, return the address. */
  abstract generateKey(): Address | Promise<Address>;

  /** Check if an address is managed by this provider. */
  hasAddress(address: Address): boolean {
    return this.getKey(address) !== null;
  }
}
