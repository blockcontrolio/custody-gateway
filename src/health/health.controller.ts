import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ClearNodeService } from '../clear-node/clear-node.service.js';
import { YellowAuthService } from '../yellow/auth/yellow-auth.service.js';
import { YellowService } from '../yellow/handler/yellow.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public } from '../auth/index.js';
import type { AuthState, ConnectionState, DbState, HealthResponse } from './health.dto.js';
import { HealthResponseDto } from './health.dto.js';

@ApiTags('Health')
@Controller()
@Public()
export class HealthController {
  private readonly startTime = Date.now();

  constructor(
    private readonly clearNodeService: ClearNodeService,
    private readonly yellowAuthService: YellowAuthService,
    private readonly yellowService: YellowService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get('health')
  @ApiOkResponse({
    description: 'Service health (websocket, auth, database, uptime)',
    type: HealthResponseDto,
  })
  async getHealth(): Promise<HealthResponse> {
    const websocket = this.clearNodeService.getConnectionState();
    const auth = this.getAuthState();
    const database = await this.getDatabaseState();
    const uptime = Date.now() - this.startTime;

    const status = this.computeStatus(websocket, auth, database);

    return {
      status,
      websocket,
      auth,
      database,
      uptime,
    };
  }

  private getAuthState(): AuthState {
    if (!this.yellowService.isEnabled()) {
      return 'not_configured';
    }
    if (!this.yellowAuthService.isConfigured()) {
      return 'not_configured';
    }
    const token = this.yellowAuthService.getSessionToken();
    return token ? 'authenticated' : 'failed';
  }

  private async getDatabaseState(): Promise<DbState> {
    try {
      await this.prismaService.$queryRaw`SELECT 1`;
      return 'connected';
    } catch {
      return 'disconnected';
    }
  }

  private computeStatus(
    websocket: ConnectionState,
    auth: AuthState,
    database: DbState,
  ): 'ok' | 'degraded' | 'down' {
    if (database === 'disconnected') {
      return 'down';
    }
    if (websocket === 'disconnected') {
      return 'down';
    }
    if (websocket === 'reconnecting') {
      return 'degraded';
    }
    if (
      this.yellowService.isEnabled() &&
      this.yellowAuthService.isConfigured() &&
      auth === 'failed'
    ) {
      return 'degraded';
    }
    return 'ok';
  }
}
