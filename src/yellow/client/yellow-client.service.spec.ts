import { RPCProtocolVersion } from '@erc7824/nitrolite';
import { YellowClientService } from './yellow-client.service';
import { YellowService } from '../handler/yellow.service';
import { ClearNodeService } from '../../clear-node/clear-node.service';
import { KeyProviderService } from '../providers/key-provider.service';
import { RequestIdService } from '../providers/request-id.service';

describe('YellowClientService', () => {
  let keyProvider: jest.Mocked<
    Pick<KeyProviderService, 'isConfigured' | 'createSigner'>
  >;
  let yellowService: jest.Mocked<
    Pick<
      YellowService,
      | 'isEnabled'
      | 'registerPendingResponse'
      | 'deletePendingResponse'
      | 'persistSignedState'
    >
  >;
  let clearNodeService: jest.Mocked<Pick<ClearNodeService, 'sendRaw'>>;
  let requestIdService: RequestIdService;
  let service: YellowClientService;

  beforeEach(() => {
    keyProvider = {
      isConfigured: jest.fn().mockReturnValue(true),
      createSigner: jest.fn().mockReturnValue(null),
    };
    yellowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      registerPendingResponse: jest.fn(),
      deletePendingResponse: jest.fn(),
      persistSignedState: jest.fn().mockResolvedValue(undefined),
    };
    clearNodeService = { sendRaw: jest.fn() };
    requestIdService = new RequestIdService();
    service = new YellowClientService(
      clearNodeService,
      yellowService,
      keyProvider,
      requestIdService,
    );
  });

  describe('isConfigured', () => {
    it('returns false when Yellow is disabled', () => {
      yellowService.isEnabled.mockReturnValue(false);
      keyProvider.isConfigured.mockReturnValue(true);
      expect(service.isConfigured()).toBe(false);
    });

    it('returns false when key provider is not configured', () => {
      keyProvider.isConfigured.mockReturnValue(false);
      expect(service.isConfigured()).toBe(false);
    });

    it('returns true when Yellow enabled and key configured', () => {
      keyProvider.isConfigured.mockReturnValue(true);
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('createAppSession', () => {
    it('rejects when signer is not configured', async () => {
      keyProvider.createSigner.mockReturnValue(null);
      await expect(
        service.createAppSession({
          definition: {
            protocol: RPCProtocolVersion.NitroRPC_0_2,
            participants: ['0x0000000000000000000000000000000000000000'],
            weights: [1],
            quorum: 1,
            challenge: 3600,
          },
          allocations: [],
        }),
      ).rejects.toThrow('YELLOW_SIGNER_PRIVATE_KEY not set or invalid');
      expect(clearNodeService.sendRaw).not.toHaveBeenCalled();
    });
  });

  describe('getChannels', () => {
    it('rejects when signer is not configured', async () => {
      keyProvider.createSigner.mockReturnValue(null);
      await expect(service.getChannels()).rejects.toThrow(
        'YELLOW_SIGNER_PRIVATE_KEY not set or invalid',
      );
    });
  });
});
