import { ConfigService } from '@nestjs/config';
import { YellowService } from './yellow.service.js';

describe('YellowService', () => {
  let service: YellowService;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue('true'),
    } as jest.Mocked<Pick<ConfigService, 'get'>>;
    service = new YellowService(configService);
  });

  describe('sessions and pending responses', () => {
    it('stores session on session_created and retrieves it', async () => {
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-99' },
      });
      const session = await service.getSession('sess-99');
      expect(session).toBeDefined();
      expect(session?.sessionId).toBe('sess-99');
    });

    it('calls pending response callback when matching response arrives', () => {
      const resolve = jest.fn();
      service.registerPendingResponse(42, resolve);
      service.handleMessage({
        kind: 'response',
        requestId: 42,
        method: 'get_ledger_balances',
        result: { balances: [] },
      });
      expect(resolve).toHaveBeenCalledWith(
        { balances: [] },
        'get_ledger_balances',
      );
    });

    it('does not call callback after deletePendingResponse', () => {
      const resolve = jest.fn();
      service.registerPendingResponse(99, resolve);
      service.deletePendingResponse(99);
      service.handleMessage({
        kind: 'response',
        requestId: 99,
        method: 'get_config',
        result: {},
      });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('rejectAllPending rejects all callbacks with error', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      service.registerPendingResponse(1, cb1);
      service.registerPendingResponse(2, cb2);
      service.rejectAllPending('Shutting down');
      expect(cb1).toHaveBeenCalledWith(expect.any(Error), 'error');
      expect(cb2).toHaveBeenCalledWith(expect.any(Error), 'error');
    });

    it('close_app_session response removes session from cache', async () => {
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-close-me' },
      });
      expect(await service.getSession('sess-close-me')).toBeDefined();

      service.handleMessage({
        kind: 'response',
        requestId: 1,
        method: 'close_app_session',
        result: { appSessionId: 'sess-close-me', version: 1, status: 'closed' },
      });
      expect(await service.getSession('sess-close-me')).toBeUndefined();
    });

    it('asu notification with status closed removes session', async () => {
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-asu' },
      });

      service.handleMessage({
        kind: 'notification',
        type: 'asu',
        payload: { appSessionId: 'sess-asu', status: 'closed' },
      });
      expect(await service.getSession('sess-asu')).toBeUndefined();
    });
  });
});
