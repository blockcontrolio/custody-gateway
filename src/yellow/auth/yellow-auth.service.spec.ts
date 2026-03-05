import { ConfigService } from '@nestjs/config';
import { YellowAuthService } from './yellow-auth.service';
import { YellowService } from '../handler/yellow.service';
import { KeyProviderService } from '../providers/key-provider.service';
import { RequestIdService } from '../providers/request-id.service';

describe('YellowAuthService', () => {
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let yellowService: jest.Mocked<
    Pick<YellowService, 'registerPendingResponse'>
  >;
  let keyProvider: jest.Mocked<
    Pick<KeyProviderService, 'isConfigured' | 'getSignerKey'>
  >;
  let requestIdService: RequestIdService;
  let service: YellowAuthService;

  beforeEach(() => {
    configService = { get: jest.fn() };
    yellowService = {
      registerPendingResponse: jest.fn(),
    };
    keyProvider = {
      isConfigured: jest.fn().mockReturnValue(false),
      getSignerKey: jest.fn().mockReturnValue(null),
    };
    requestIdService = new RequestIdService();
    service = new YellowAuthService(
      null,
      yellowService,
      configService,
      requestIdService,
      keyProvider,
    );
  });

  describe('getSessionToken', () => {
    it('returns null when no token stored', () => {
      expect(service.getSessionToken()).toBeNull();
    });
  });

  describe('isConfigured', () => {
    it('returns false when key provider reports not configured', () => {
      keyProvider.isConfigured.mockReturnValue(false);
      expect(service.isConfigured()).toBe(false);
    });

    it('returns true when key provider reports configured', () => {
      keyProvider.isConfigured.mockReturnValue(true);
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('startAuth', () => {
    it('returns without sending when key is not configured', async () => {
      keyProvider.isConfigured.mockReturnValue(false);
      await service.startAuth();
      expect(yellowService.registerPendingResponse).not.toHaveBeenCalled();
    });

    it('returns without sending when ClearNodeService is null', async () => {
      keyProvider.isConfigured.mockReturnValue(true);
      await service.startAuth();
      expect(yellowService.registerPendingResponse).not.toHaveBeenCalled();
    });
  });
});
