import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { YellowController } from './yellow.controller.js';
import { SessionService } from './session.service.js';

describe('YellowController (Sessions)', () => {
  let controller: YellowController;
  let sessionService: jest.Mocked<
    Pick<
      SessionService,
      | 'createInvitation'
      | 'listInvitations'
      | 'acceptInvitation'
      | 'rejectInvitation'
      | 'listSessions'
      | 'getSession'
      | 'updateState'
      | 'closeSession'
      | 'recoverFunds'
    >
  >;

  beforeEach(async () => {
    sessionService = {
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue([]),
      acceptInvitation: jest.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'open' }),
      rejectInvitation: jest.fn(),
      listSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockResolvedValue(null),
      updateState: jest.fn().mockResolvedValue({ sessionId: 'sess-1' }),
      closeSession: jest.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'closed' }),
      recoverFunds: jest.fn().mockResolvedValue({ withdrawn: '0' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [YellowController],
      providers: [{ provide: SessionService, useValue: sessionService }],
    }).compile();

    controller = module.get<YellowController>(YellowController);
  });

  it('delegates invite to sessionService', async () => {
    const dto = {
      token: 'usdc',
      initiatorUserId: 'u1',
      inviteeUserId: 'u2',
      amountInitiator: '2000000',
      amountInvitee: '2000000',
    };
    await controller.invite(dto);
    expect(sessionService.createInvitation).toHaveBeenCalledWith(dto);
  });

  it('throws 400 when userId missing for invitations', async () => {
    await expect(controller.listInvitations()).rejects.toThrow(BadRequestException);
  });

  it('returns empty list when no sessions', async () => {
    expect(await controller.list()).toEqual([]);
  });

  it('throws 400 when allocations empty on state update', async () => {
    await expect(controller.updateState('sess-1', { allocations: [] } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws 400 when allocations empty on close', async () => {
    await expect(controller.close('sess-1', { allocations: [] } as any)).rejects.toThrow(
      BadRequestException,
    );
  });
});
