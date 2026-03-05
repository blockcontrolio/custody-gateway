import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { ClearNodeService } from './../src/clear-node/clear-node.service';
import { PrismaService } from './../src/prisma/prisma.service';

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.CLEARNODE_URL =
      process.env.CLEARNODE_URL ?? 'wss://clearnet-sandbox.yellow.com/ws';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/test';

    const mockClearNode = {
      getConnectionState: () => 'disconnected' as const,
      sendRaw: () => {},
      sendJson: () => {},
    };

    const mockPrisma = {
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
      $queryRaw: () => Promise.resolve([{ 1: 1 }]),
      yellowSession: { findMany: () => [], findUnique: () => null },
      channelState: {},
      signedState: {},
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ClearNodeService)
      .useValue(mockClearNode)
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('GET /health returns status', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('status');
        expect(res.body).toHaveProperty('websocket');
        expect(res.body).toHaveProperty('database');
        expect(res.body).toHaveProperty('uptime');
      });
  });
});
