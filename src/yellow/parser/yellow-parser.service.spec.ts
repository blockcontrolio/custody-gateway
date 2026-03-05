import { YellowParserService } from './yellow-parser.service';

describe('YellowParserService', () => {
  let service: YellowParserService;

  beforeEach(() => {
    service = new YellowParserService({ get: jest.fn() });
  });

  it('returns null for empty or whitespace', () => {
    expect(service.parse('')).toBeNull();
    expect(service.parse('   ')).toBeNull();
  });

  it('parses Nitro RPC response (res)', () => {
    const raw = JSON.stringify({
      res: [1, 'get_ledger_balances', { balances: [] }, 1700000000000],
      sig: ['0x00'],
    });
    expect(service.parse(raw)).toEqual({
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
    expect(service.parse(raw)).toEqual({
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
    expect(service.parse(raw)).toEqual({
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
    expect(service.parse(raw)).toEqual({
      kind: 'notification',
      type: 'session_created',
      payload: { type: 'session_created', sessionId: 'sess-123' },
    });
  });

  it('returns unknown for JSON without res/req/type', () => {
    expect(service.parse(JSON.stringify({ foo: 'bar' }))).toEqual({
      kind: 'unknown',
      raw: { foo: 'bar' },
    });
  });

  it('returns null for invalid JSON', () => {
    expect(service.parse('not json')).toBeNull();
    expect(service.parse('{')).toBeNull();
  });
});
