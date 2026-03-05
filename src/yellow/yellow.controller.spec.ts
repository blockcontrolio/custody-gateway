import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { YellowController } from './yellow.controller';
import { YellowClientService } from './client/yellow-client.service';
import { YellowService } from './handler/yellow.service';
import { YellowAuthService } from './auth/yellow-auth.service';
import type { StoredSession } from './handler/yellow.service';
import type { CreateAppSessionDto } from './dto';
import type { SubmitAppStateDto } from './dto';
import type { CloseAppSessionDto } from './dto';
import type { TransferDto } from './dto';

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
  let yellowAuth: jest.Mocked<Pick<YellowAuthService, 'getSessionToken'>>;

  const enabledAndConfigured = () => {
    yellowService.isEnabled.mockReturnValue(true);
    yellowClient.isConfigured.mockReturnValue(true);
  };

  const disabledOrUnconfigured = (enabled: boolean, configured: boolean) => {
    yellowService.isEnabled.mockReturnValue(enabled);
    yellowClient.isConfigured.mockReturnValue(configured);
  };

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
    yellowAuth = {
      getSessionToken: jest.fn().mockReturnValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [YellowController],
      providers: [
        {
          provide: YellowClientService,
          useValue: yellowClient,
        },
        {
          provide: YellowService,
          useValue: yellowService,
        },
        {
          provide: YellowAuthService,
          useValue: yellowAuth,
        },
      ],
    }).compile();

    controller = module.get<YellowController>(YellowController);
  });

  describe('getStatus', () => {
    it('returns enabled, configured, hasSessionToken', () => {
      enabledAndConfigured();
      yellowAuth.getSessionToken.mockReturnValue('jwt-token');
      const status = controller.getStatus();
      expect(status).toEqual({
        enabled: true,
        configured: true,
        hasSessionToken: true,
      });
    });

    it('returns hasSessionToken false when no token', () => {
      enabledAndConfigured();
      yellowAuth.getSessionToken.mockReturnValue(null);
      const status = controller.getStatus();
      expect(status.hasSessionToken).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('returns all sessions when enabled', async () => {
      const sessions: StoredSession[] = [
        { sessionId: 's1', createdAt: 1000 },
        { sessionId: 's2', createdAt: 2000 },
      ];
      yellowService.getAllSessions.mockResolvedValue(sessions);
      await expect(controller.listSessions()).resolves.toEqual(sessions);
    });

    it('returns empty array when Yellow disabled', async () => {
      yellowService.isEnabled.mockReturnValue(false);
      await expect(controller.listSessions()).resolves.toEqual([]);
      expect(yellowService.getAllSessions).not.toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    it('returns session when found', async () => {
      const session: StoredSession = { sessionId: 'sess-x', createdAt: 123 };
      yellowService.getSession.mockResolvedValue(session);
      await expect(controller.getSession('sess-x')).resolves.toEqual(session);
    });

    it('returns null when not found', async () => {
      yellowService.getSession.mockResolvedValue(undefined);
      await expect(controller.getSession('missing')).resolves.toBeNull();
    });

    it('returns null when Yellow disabled', async () => {
      yellowService.isEnabled.mockReturnValue(false);
      await expect(controller.getSession('any')).resolves.toBeNull();
    });
  });

  describe('createAppSession', () => {
    const validBody = {
      definition: {
        protocol: 'NitroRPC/0.2',
        participants: ['0xaaa', '0xbbb'],
        weights: [1, 1],
        quorum: 1,
        challenge: 0,
      },
      allocations: [{ asset: 'USDC', amount: '100', participant: '0xaaa' }],
    };

    it('returns result from yellowClient.createAppSession', async () => {
      enabledAndConfigured();
      const result = { sessionId: 'new-sess' };
      yellowClient.createAppSession.mockResolvedValue(result);
      await expect(controller.createAppSession(validBody)).resolves.toEqual(
        result,
      );
      expect(yellowClient.createAppSession).toHaveBeenCalledWith(validBody);
    });

    it('throws 400 when definition missing', async () => {
      enabledAndConfigured();
      const badBody = {
        definition: undefined,
        allocations: [],
      } as unknown as CreateAppSessionDto;
      await expect(controller.createAppSession(badBody)).rejects.toThrow(
        'Body must include definition and allocations',
      );
    });

    it('throws 400 when allocations not array', async () => {
      enabledAndConfigured();
      const badBody = {
        definition: validBody.definition,
        allocations: null,
      } as unknown as CreateAppSessionDto;
      await expect(controller.createAppSession(badBody)).rejects.toThrow(
        'Body must include definition and allocations',
      );
    });

    it('throws 503 when Yellow disabled', async () => {
      disabledOrUnconfigured(false, true);
      await expect(controller.createAppSession(validBody)).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(controller.createAppSession(validBody)).rejects.toThrow(
        'Yellow partner is disabled',
      );
    });

    it('throws 503 when not configured (no signer)', async () => {
      disabledOrUnconfigured(true, false);
      await expect(controller.createAppSession(validBody)).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(controller.createAppSession(validBody)).rejects.toThrow(
        'YELLOW_SIGNER_PRIVATE_KEY',
      );
    });
  });

  describe('submitAppState', () => {
    const validBody = {
      allocations: [{ asset: 'USDC', amount: '50', participant: '0xaaa' }],
    };

    it('calls yellowClient.submitAppState with sessionId and body', async () => {
      enabledAndConfigured();
      yellowClient.submitAppState.mockResolvedValue({ ok: true });
      await controller.submitAppState('sess-123', validBody);
      expect(yellowClient.submitAppState).toHaveBeenCalledWith(
        expect.objectContaining({
          app_session_id: 'sess-123',
          allocations: validBody.allocations,
        }),
      );
    });

    it('throws 400 when allocations missing', async () => {
      enabledAndConfigured();
      const badBody = {
        allocations: undefined,
      } as unknown as SubmitAppStateDto;
      await expect(
        controller.submitAppState('sess-1', badBody),
      ).rejects.toThrow('Body must include allocations');
    });

    it('throws 503 when not configured', async () => {
      disabledOrUnconfigured(true, false);
      await expect(
        controller.submitAppState('sess-1', validBody),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('closeAppSession', () => {
    const validBody = {
      allocations: [{ asset: 'USDC', amount: '0', participant: '0xaaa' }],
    };

    it('calls yellowClient.closeAppSession with sessionId and body', async () => {
      enabledAndConfigured();
      await controller.closeAppSession('sess-close', validBody);
      expect(yellowClient.closeAppSession).toHaveBeenCalledWith(
        expect.objectContaining({
          app_session_id: 'sess-close',
          allocations: validBody.allocations,
        }),
      );
    });

    it('throws 400 when allocations missing', async () => {
      enabledAndConfigured();
      const badBody = { allocations: null } as unknown as CloseAppSessionDto;
      await expect(
        controller.closeAppSession('sess-1', badBody),
      ).rejects.toThrow('Body must include allocations');
    });

    it('throws 503 when not configured', async () => {
      disabledOrUnconfigured(false, true);
      await expect(
        controller.closeAppSession('sess-1', validBody),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('getChannels', () => {
    it('calls yellowClient.getChannels with no args when no query', async () => {
      enabledAndConfigured();
      await controller.getChannels();
      expect(yellowClient.getChannels).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
    });

    it('calls yellowClient.getChannels with participant and status', async () => {
      enabledAndConfigured();
      await controller.getChannels('0xabc', 'open');
      expect(yellowClient.getChannels).toHaveBeenCalledWith(
        '0xabc',
        expect.any(String),
      );
      const lastCall = (yellowClient.getChannels as jest.Mock).mock
        .calls[0] as [string | undefined, string];
      expect(lastCall[1]).toBe('open'); // RPCChannelStatus.Open
    });

    it('maps status query to enum: closed, challenged', async () => {
      enabledAndConfigured();
      await controller.getChannels(undefined, 'closed');
      expect(yellowClient.getChannels).toHaveBeenCalledWith(
        undefined,
        'closed',
      );
      await controller.getChannels(undefined, 'challenged');
      expect(yellowClient.getChannels).toHaveBeenLastCalledWith(
        undefined,
        'challenged',
      );
    });

    it('throws 503 when not configured', async () => {
      disabledOrUnconfigured(true, false);
      await expect(controller.getChannels()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('transfer', () => {
    const validBodyWithDestination = {
      destination: '0xrecipient',
      allocations: [{ asset: 'USDC', amount: '100' }],
    };
    const validBodyWithTag = {
      destination_user_tag: 'user-123',
      allocations: [{ asset: 'USDC', amount: '50' }],
    };

    it('calls yellowClient.transfer when destination provided', async () => {
      enabledAndConfigured();
      await controller.transfer(validBodyWithDestination);
      expect(yellowClient.transfer).toHaveBeenCalledWith(
        validBodyWithDestination,
      );
    });

    it('calls yellowClient.transfer when destination_user_tag provided', async () => {
      enabledAndConfigured();
      await controller.transfer(validBodyWithTag);
      expect(yellowClient.transfer).toHaveBeenCalledWith(validBodyWithTag);
    });

    it('throws 400 when allocations missing', async () => {
      enabledAndConfigured();
      const badBody = {
        destination: '0xa',
        allocations: null,
      } as unknown as TransferDto;
      await expect(controller.transfer(badBody)).rejects.toThrow(
        'Body must include allocations',
      );
    });

    it('throws 400 when neither destination nor destination_user_tag', async () => {
      enabledAndConfigured();
      await expect(
        controller.transfer({
          allocations: [{ asset: 'USDC', amount: '100' }],
        }),
      ).rejects.toThrow(
        'Either destination (address) or destination_user_tag is required',
      );
    });

    it('throws 503 when not configured', async () => {
      disabledOrUnconfigured(true, false);
      await expect(
        controller.transfer(validBodyWithDestination),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
