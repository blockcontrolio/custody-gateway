import { ConfigService } from '@nestjs/config';
import { YellowService } from './yellow.service';

describe('YellowService', () => {
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let service: YellowService;

  beforeEach(() => {
    configService = { get: jest.fn() };
    service = new YellowService(configService);
  });

  describe('isEnabled', () => {
    it('returns true when YELLOW_PARTNER_ENABLED is "true"', () => {
      configService.get.mockReturnValue('true');
      expect(service.isEnabled()).toBe(true);
    });

    it('returns true when YELLOW_PARTNER_ENABLED is "1"', () => {
      configService.get.mockReturnValue('1');
      expect(service.isEnabled()).toBe(true);
    });

    it('returns false when YELLOW_PARTNER_ENABLED is "false" or missing', () => {
      configService.get.mockReturnValue('false');
      expect(service.isEnabled()).toBe(false);
      configService.get.mockReturnValue(undefined);
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('handleMessage', () => {
    it('handles response and calls handleResponse logic', () => {
      const spy = jest.spyOn(service as any, 'handleResponse');
      service.handleMessage({
        kind: 'response',
        requestId: 1,
        method: 'get_channels',
        result: {},
      });
      expect(spy).toHaveBeenCalledWith('get_channels', {}, 1);
    });

    it('handles notification session_created and calls onSessionCreated', () => {
      const spy = jest.spyOn(service, 'onSessionCreated');
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-1' },
      });
      expect(spy).toHaveBeenCalledWith('sess-1');
    });

    it('handles notification payment and calls onPayment', () => {
      const spy = jest.spyOn(service, 'onPayment');
      const payload = { amount: '100', sender: '0xaa', recipient: '0xbb' };
      service.handleMessage({
        kind: 'notification',
        type: 'payment',
        payload,
      });
      expect(spy).toHaveBeenCalledWith(payload);
    });

    it('handles error and calls onError', () => {
      const spy = jest.spyOn(service, 'onError');
      service.handleMessage({
        kind: 'error',
        requestId: 5,
        error: 'Something failed',
      });
      expect(spy).toHaveBeenCalledWith('Something failed', 5);
    });

    it('handles unknown and does not throw', () => {
      expect(() =>
        service.handleMessage({ kind: 'unknown', raw: { x: 1 } }),
      ).not.toThrow();
    });
  });

  describe('sessions and pending responses', () => {
    it('stores session on session_created and getSession returns it', async () => {
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-99' },
      });
      const session = await service.getSession('sess-99');
      expect(session).toBeDefined();
      expect(session?.sessionId).toBe('sess-99');
      expect(session?.createdAt).toBeDefined();
    });

    it('calls pending response callback when response with requestId arrives', () => {
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

    it('does not call callback after deletePendingResponse (e.g. timeout)', () => {
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

    it('getAllSessions returns all stored sessions', async () => {
      expect(await service.getAllSessions()).toEqual([]);
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 's1' },
      });
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 's2' },
      });
      const all = await service.getAllSessions();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
    });

    it('rejectAllPending rejects all pending callbacks with reason', async () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      service.registerPendingResponse(1, cb1);
      service.registerPendingResponse(2, cb2);
      service.rejectAllPending('Shutting down');
      expect(cb1).toHaveBeenCalledWith(expect.any(Error), 'error');
      expect(cb2).toHaveBeenCalledWith(expect.any(Error), 'error');
      const firstCallArgs = cb1.mock.calls[0] as [Error, string] | undefined;
      expect(firstCallArgs?.[0].message).toBe('Shutting down');
      expect((await service.getAllSessions()).length).toBe(0); // sessions unchanged
    });

    it('close_app_session response calls onSessionClosed and removes from cache', async () => {
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-close-me' },
      });
      expect(await service.getSession('sess-close-me')).toBeDefined();

      const onClosedSpy = jest.spyOn(service, 'onSessionClosed');
      service.handleMessage({
        kind: 'response',
        requestId: 1,
        method: 'close_app_session',
        result: { appSessionId: 'sess-close-me', version: 1, status: 'closed' },
      });
      expect(onClosedSpy).toHaveBeenCalledWith('sess-close-me');
      expect(await service.getSession('sess-close-me')).toBeUndefined();
    });

    it('asu notification with status closed calls onSessionClosed', () => {
      service.handleMessage({
        kind: 'notification',
        type: 'session_created',
        payload: { sessionId: 'sess-asu' },
      });

      const onClosedSpy = jest.spyOn(service, 'onSessionClosed');
      service.handleMessage({
        kind: 'notification',
        type: 'asu',
        payload: { appSessionId: 'sess-asu', status: 'closed' },
      });
      expect(onClosedSpy).toHaveBeenCalledWith('sess-asu');
    });
  });
});
