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
    service = new YellowClientService(
      clearNodeService,
      yellowService,
      keyProvider,
      new RequestIdService(),
    );
  });

  describe('isConfigured', () => {
    it('returns false when Yellow is disabled', () => {
      yellowService.isEnabled.mockReturnValue(false);
      expect(service.isConfigured()).toBe(false);
    });

    it('returns true when Yellow enabled and key configured', () => {
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('createAppSession', () => {
    it('rejects when signer is not configured', async () => {
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
    });
  });
});
