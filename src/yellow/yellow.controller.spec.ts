import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { YellowController } from './yellow.controller.js';
import { YellowClientService } from './client/yellow-client.service.js';
import { YellowService } from './handler/yellow.service.js';
import { AccountService } from '../account/index.js';
import { InvitationRepository } from '../repository/invitation.repository.js';
import { CustodyService } from '../custody/custody.service.js';

describe('YellowController (Sessions)', () => {
  let controller: YellowController;
  let yellowClient: jest.Mocked<Pick<YellowClientService, 'isConfigured' | 'createAppSession' | 'submitAppState' | 'closeAppSession'>>;
  let yellowService: jest.Mocked<Pick<YellowService, 'isEnabled' | 'getAllSessions' | 'getSession'>>;

  beforeEach(async () => {
    yellowClient = {
      isConfigured: jest.fn().mockReturnValue(true),
      createAppSession: jest.fn().mockResolvedValue({ app_session_id: 'sess-1' }),
      submitAppState: jest.fn().mockResolvedValue({ ok: true }),
      closeAppSession: jest.fn().mockResolvedValue({ ok: true }),
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
          provide: AccountService,
          useValue: { resolveAddress: jest.fn().mockResolvedValue('0x1234') },
        },
        {
          provide: InvitationRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            findPendingForAddress: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CustodyService,
          useValue: {
            getCustodyBalance: jest.fn().mockResolvedValue({ balance: '0' }),
            withdraw: jest.fn().mockResolvedValue({ txHash: '0x' }),
          },
        },
      ],
    }).compile();

    controller = module.get<YellowController>(YellowController);
  });

  describe('ensureYellowReady', () => {
    it('throws 503 when Yellow is disabled', async () => {
      yellowService.isEnabled.mockReturnValue(false);
      await expect(
        controller.updateState('sess-1', { allocations: [{ asset: 'usdc', amount: '100', participant: '0x1' }] } as any),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws 503 when signer not configured', async () => {
      yellowClient.isConfigured.mockReturnValue(false);
      await expect(
        controller.updateState('sess-1', { allocations: [{ asset: 'usdc', amount: '100', participant: '0x1' }] } as any),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('invite', () => {
    it('throws 400 when both addresses missing', async () => {
      await expect(
        controller.invite({ token: 'usdc', amountInitiator: '100', amountInvitee: '0' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('list sessions', () => {
    it('returns empty when disabled', async () => {
      yellowService.isEnabled.mockReturnValue(false);
      expect(await controller.list()).toEqual([]);
    });
  });

  describe('close', () => {
    it('throws 400 when allocations missing', async () => {
      await expect(
        controller.close('sess-1', { allocations: [] } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
