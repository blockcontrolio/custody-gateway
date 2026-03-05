import { KeyProviderService } from './key-provider.service';

describe('KeyProviderService', () => {
  const VALID_KEY =
    '0x1234567890123456789012345678901234567890123456789012345678901234';

  function createService(keyValue?: string) {
    const configService = { get: jest.fn().mockReturnValue(keyValue) };
    return new KeyProviderService(configService);
  }

  describe('getSignerKey', () => {
    it('returns null when key is not set', () => {
      expect(createService(undefined).getSignerKey()).toBeNull();
    });

    it('returns null when key does not start with 0x', () => {
      expect(createService('abc123').getSignerKey()).toBeNull();
    });

    it('returns null when key is too short', () => {
      expect(createService('0x1234').getSignerKey()).toBeNull();
    });

    it('returns key when valid', () => {
      expect(createService(VALID_KEY).getSignerKey()).toBe(VALID_KEY);
    });
  });

  describe('isConfigured', () => {
    it('returns false when key is not set', () => {
      expect(createService(undefined).isConfigured()).toBe(false);
    });

    it('returns true when key is valid', () => {
      expect(createService(VALID_KEY).isConfigured()).toBe(true);
    });
  });

  describe('createSigner', () => {
    it('returns null when key is not set', () => {
      expect(createService(undefined).createSigner()).toBeNull();
    });

    it('returns a signer function when key is valid', () => {
      const signer = createService(VALID_KEY).createSigner();
      expect(signer).toBeDefined();
      expect(typeof signer).toBe('function');
    });
  });
});
