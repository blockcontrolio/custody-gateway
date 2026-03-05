import { YellowParserService } from './yellow-parser.service';

describe('YellowParserService', () => {
  let service: YellowParserService;
  const configService = { get: jest.fn().mockReturnValue(undefined) };

  beforeEach(() => {
    service = new YellowParserService(configService);
  });

  describe('parse', () => {
    it('returns null for empty or whitespace', () => {
      expect(service.parse('')).toBeNull();
      expect(service.parse('   ')).toBeNull();
    });

    it('parses Nitro RPC response (res)', () => {
      const raw = JSON.stringify({
        res: [1, 'get_ledger_balances', { balances: [] }, 1700000000000],
        sig: ['0x00'],
      });
      const parsed = service.parse(raw);
      expect(parsed).toEqual({
        kind: 'response',
        requestId: 1,
        method: 'get_ledger_balances',
        result: { balances: [] },
        timestamp: 1700000000000,
      });
    });

    it('parses Nitro RPC error response', () => {
      const raw = JSON.stringify({
        res: [2, 'error', { error: 'Invalid signature' }, 1700000000000],
        sig: ['0x00'],
      });
      const parsed = service.parse(raw);
      expect(parsed).toEqual({
        kind: 'error',
        requestId: 2,
        error: 'Invalid signature',
        timestamp: 1700000000000,
      });
    });

    it('parses Nitro RPC request (req)', () => {
      const raw = JSON.stringify({
        req: [3, 'auth_request', { clientId: 'test' }, 1700000000000],
        sig: ['0x00'],
      });
      const parsed = service.parse(raw);
      expect(parsed).toEqual({
        kind: 'request',
        requestId: 3,
        method: 'auth_request',
        params: { clientId: 'test' },
        timestamp: 1700000000000,
      });
    });

    it('parses notification (type field)', () => {
      const raw = JSON.stringify({
        type: 'session_created',
        sessionId: 'sess-123',
      });
      const parsed = service.parse(raw);
      expect(parsed).toEqual({
        kind: 'notification',
        type: 'session_created',
        payload: { type: 'session_created', sessionId: 'sess-123' },
      });
    });

    it('parses notification bu (balance update)', () => {
      const raw = JSON.stringify({ type: 'bu', balance: '100' });
      const parsed = service.parse(raw);
      expect(parsed?.kind).toBe('notification');
      expect(
        parsed && parsed.kind === 'notification' ? parsed.type : undefined,
      ).toBe('bu');
    });

    it('returns unknown for JSON without res/req/type', () => {
      const raw = JSON.stringify({ foo: 'bar' });
      const parsed = service.parse(raw);
      expect(parsed).toEqual({ kind: 'unknown', raw: { foo: 'bar' } });
    });

    it('returns null for invalid JSON', () => {
      expect(service.parse('not json')).toBeNull();
      expect(service.parse('{')).toBeNull();
    });
  });
});
