/**
 * E2E integration test against Yellow ClearNode sandbox.
 * Requires:
 *   - YELLOW_SANDBOX_E2E=true (or any value)
 *   - DATABASE_URL (PostgreSQL)
 *   - CLEARNODE_URL (sandbox: wss://clearnet-sandbox.yellow.com/ws)
 *   - Optionally YELLOW_SIGNER_PRIVATE_KEY for auth/channels
 *
 * Skip in CI without these env vars.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- supertest Response.body and matchers are untyped */
const SKIP_REASON =
  'Set YELLOW_SANDBOX_E2E=true and DATABASE_URL to run sandbox e2e';

const shouldRun = process.env.YELLOW_SANDBOX_E2E && process.env.DATABASE_URL;

describe('Yellow Sandbox (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    if (!shouldRun) return;
    process.env.CLEARNODE_URL =
      process.env.CLEARNODE_URL ?? 'wss://clearnet-sandbox.yellow.com/ws';
    process.env.YELLOW_PARTNER_ENABLED =
      process.env.YELLOW_PARTNER_ENABLED ?? 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /health returns status, websocket, auth, database, uptime', async () => {
    if (!shouldRun) {
      console.log(`Skipped: ${SKIP_REASON}`);
      return;
    }
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    type HealthBody = {
      status: string;
      websocket: string;
      auth: string;
      database: string;
      uptime: number;
    };

    const body = res.body as HealthBody;

    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded|down)$/),
      websocket: expect.stringMatching(
        /^(connected|disconnected|reconnecting)$/,
      ),
      auth: expect.stringMatching(/^(authenticated|not_configured|failed)$/),
      database: expect.stringMatching(/^(connected|disconnected)$/),
    });
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('GET /yellow/status returns enabled, configured, hasSessionToken', async () => {
    if (!shouldRun) return;
    const res = await request(app.getHttpServer())
      .get('/yellow/status')
      .expect(200);
    type StatusBody = {
      enabled: boolean;
      configured: boolean;
      hasSessionToken: boolean;
    };

    const body = res.body as StatusBody;

    expect(body).toMatchObject({
      enabled: expect.any(Boolean),
      configured: expect.any(Boolean),
      hasSessionToken: expect.any(Boolean),
    });
  }, 5_000);
});
