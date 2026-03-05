import { ConfigService } from '@nestjs/config';
import { ClearNodeService } from './clear-node.service';
import { YellowAuthService } from '../yellow/auth/yellow-auth.service';
import { YellowService } from '../yellow/handler/yellow.service';
import { YellowParserService } from '../yellow/parser/yellow-parser.service';
import { ParsedMessage } from '../yellow/yellow.types';

const mockWsInstances: Array<{
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  on: jest.Mock;
  close: jest.Mock;
  readyState: number;
  send: jest.Mock;
}> = [];

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn(function (this: any) {
    const mock = {
      onmessage: null as ((event: { data: string }) => void) | null,
      onopen: null as (() => void) | null,
      on: jest.fn(),
      close: jest.fn(),
      readyState: 1,
      send: jest.fn(),
    };
    mockWsInstances.push(mock);
    return mock;
  }),
}));

describe('ClearNodeService', () => {
  let configService: jest.Mocked<Pick<ConfigService, 'get' | 'getOrThrow'>>;
  let yellowParserService: jest.Mocked<
    Pick<YellowParserService, 'parse' | 'parseAndVerify'>
  >;
  let yellowService: jest.Mocked<
    Pick<YellowService, 'isEnabled' | 'handleMessage'>
  >;
  let yellowAuthService: jest.Mocked<
    Pick<YellowAuthService, 'isConfigured' | 'startAuth'>
  >;
  let service: ClearNodeService;

  beforeEach(() => {
    mockWsInstances.length = 0;
    configService = {
      get: jest.fn(),
      getOrThrow: jest.fn().mockReturnValue('wss://test.example/ws'),
    };
    yellowParserService = {
      parse: jest.fn(),
      parseAndVerify: jest.fn(),
    };
    yellowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      handleMessage: jest.fn(),
    };
    yellowAuthService = {
      isConfigured: jest.fn().mockReturnValue(false),
      startAuth: jest.fn().mockResolvedValue(undefined),
    };
    service = new ClearNodeService(
      configService,
      yellowParserService,
      yellowService,
      yellowAuthService,
    );
  });

  describe('onmessage with YELLOW_PARTNER_ENABLED true', () => {
    it('calls parser and handleMessage when message is valid Nitro RPC', () => {
      service.onModuleInit();
      const mockWs = mockWsInstances[0];
      expect(mockWs).toBeDefined();
      expect(mockWs.onmessage).toBeDefined();

      const rawMessage = JSON.stringify({
        res: [1, 'get_ledger_balances', { balances: [] }, 1700000000000],
        sig: [],
      });
      const parsed: ParsedMessage = {
        kind: 'response',
        requestId: 1,
        method: 'get_ledger_balances',
        result: { balances: [] },
        timestamp: 1700000000000,
      };
      yellowParserService.parse.mockReturnValue(parsed);

      mockWs.onmessage!({ data: rawMessage });

      expect(yellowParserService.parse).toHaveBeenCalledWith(rawMessage);
      expect(yellowService.handleMessage).toHaveBeenCalledWith(parsed);
    });

    it('does not call handleMessage when parser returns null', () => {
      service.onModuleInit();
      const mockWs = mockWsInstances[0];
      yellowParserService.parse.mockReturnValue(null);

      mockWs.onmessage!({ data: 'garbage' });

      expect(yellowParserService.parse).toHaveBeenCalledWith('garbage');
      expect(yellowService.handleMessage).not.toHaveBeenCalled();
    });

    it('handles notification (session_created) through parser and YellowService', () => {
      service.onModuleInit();
      const mockWs = mockWsInstances[0];
      const rawMessage = JSON.stringify({
        type: 'session_created',
        sessionId: 'sess-123',
      });
      const parsed: ParsedMessage = {
        kind: 'notification',
        type: 'session_created',
        payload: { type: 'session_created', sessionId: 'sess-123' },
      };
      yellowParserService.parse.mockReturnValue(parsed);

      mockWs.onmessage!({ data: rawMessage });

      expect(yellowParserService.parse).toHaveBeenCalledWith(rawMessage);
      expect(yellowService.handleMessage).toHaveBeenCalledWith(parsed);
    });
  });

  describe('onmessage with YELLOW_PARTNER_ENABLED false', () => {
    it('does not call parser or handleMessage, only parses as JSON', () => {
      yellowService.isEnabled.mockReturnValue(false);
      service.onModuleInit();
      const mockWs = mockWsInstances[0];
      const rawMessage = JSON.stringify({ res: [1, 'ok', {}, 0] });

      mockWs.onmessage!({ data: rawMessage });

      expect(yellowParserService.parse).not.toHaveBeenCalled();
      expect(yellowService.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe('onmessage error handling', () => {
    it('does not throw when handleMessage throws', () => {
      service.onModuleInit();
      const mockWs = mockWsInstances[0];
      yellowParserService.parse.mockReturnValue({
        kind: 'notification',
        type: 'payment',
        payload: {},
      });
      yellowService.handleMessage.mockImplementation(() => {
        throw new Error('Handler error');
      });

      expect(() =>
        mockWs.onmessage!({ data: '{"type":"payment"}' }),
      ).not.toThrow();
    });
  });
});
