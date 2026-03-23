import { RPCProtocolVersion } from '@erc7824/nitrolite';
import { YellowClientService } from './yellow-client.service.js';
import { YellowService } from '../handler/yellow.service.js';
import { ClearNodeService } from '../../clear-node/clear-node.service.js';
import { KeyProviderService } from '../providers/key-provider.service.js';
import { KeyProvider } from '../../key-provider/index.js';
import { RequestIdService } from '../providers/request-id.service.js';

describe('YellowClientService', () => {
  let keyProvider: jest.Mocked<
    Pick<KeyProviderService, 'isConfigured' | 'createSigner' | 'createSignerForAddress'>
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
  let globalKeyProvider: jest.Mocked<Pick<KeyProvider, 'getKey' | 'listAddresses'>>;
  let service: YellowClientService;

  beforeEach(() => {
    keyProvider = {
      isConfigured: jest.fn().mockReturnValue(true),
      createSigner: jest.fn().mockReturnValue(null),
      createSignerForAddress: jest.fn().mockReturnValue(null),
    };
    yellowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      registerPendingResponse: jest.fn(),
      deletePendingResponse: jest.fn(),
      persistSignedState: jest.fn().mockResolvedValue(undefined),
    };
    clearNodeService = { sendRaw: jest.fn() };
    globalKeyProvider = {
      getKey: jest.fn().mockReturnValue(null),
      listAddresses: jest.fn().mockReturnValue([]),
    };
    service = new YellowClientService(
      clearNodeService,
      yellowService,
      keyProvider,
      new RequestIdService(),
      globalKeyProvider as unknown as KeyProvider,
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
            application: 'custody-gateway',
          },
          allocations: [],
        }),
      ).rejects.toThrow('YELLOW_SIGNER_PRIVATE_KEY not set or invalid');
    });
  });
});
