import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { YellowController } from './yellow.controller';
import { YellowClientService } from './client/yellow-client.service';
import { YellowService } from './handler/yellow.service';
import { YellowAuthService } from './auth/yellow-auth.service';

describe('YellowController', () => {
  let controller: YellowController;
  let yellowClient: jest.Mocked<
    Pick<
      YellowClientService,
      | 'isConfigured'
      | 'createAppSession'
      | 'submitAppState'
      | 'closeAppSession'
      | 'getChannels'
      | 'transfer'
    >
  >;
  let yellowService: jest.Mocked<
    Pick<YellowService, 'isEnabled' | 'getAllSessions' | 'getSession'>
  >;

  beforeEach(async () => {
    yellowClient = {
      isConfigured: jest.fn().mockReturnValue(true),
      createAppSession: jest.fn().mockResolvedValue({ sessionId: 'sess-1' }),
      submitAppState: jest.fn().mockResolvedValue({ ok: true }),
      closeAppSession: jest.fn().mockResolvedValue({ ok: true }),
      getChannels: jest.fn().mockResolvedValue({ channels: [] }),
      transfer: jest.fn().mockResolvedValue({ txId: 'tx-1' }),
    };
    yellowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      getAllSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [YellowController],
      providers: [
        { provide: YellowClientService, useValue: yellowClient },
        { provide: YellowService, useValue: yellowService },
        {
          provide: YellowAuthService,
          useValue: { getSessionToken: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    controller = module.get<YellowController>(YellowController);
  });

  describe('ensureYellowReady guard', () => {
    it('throws 503 when Yellow is disabled', async () => {
      yellowService.isEnabled.mockReturnValue(false);
      await expect(
        controller.createAppSession({ definition: {} as any, allocations: [] }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws 503 when signer not configured', async () => {
      yellowClient.isConfigured.mockReturnValue(false);
      await expect(
        controller.createAppSession({ definition: {} as any, allocations: [] }),
      ).rejects.toThrow('YELLOW_SIGNER_PRIVATE_KEY');
    });
  });

  describe('body validation', () => {
    it('throws 400 when createAppSession definition missing', async () => {
      await expect(
        controller.createAppSession({ definition: undefined, allocations: [] } as any),
      ).rejects.toThrow('Body must include definition and allocations');
    });

    it('throws 400 when transfer has no destination', async () => {
      await expect(
        controller.transfer({ allocations: [{ asset: 'USDC', amount: '100' }] }),
      ).rejects.toThrow('Either destination');
    });
  });
});
