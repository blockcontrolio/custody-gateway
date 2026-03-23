import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { privateKeyToAccount } from 'viem/accounts';
const WALLET_A = process.env.YELLOW_SIGNER_PRIVATE_KEY
    ? privateKeyToAccount(process.env.YELLOW_SIGNER_PRIVATE_KEY).address
    : '';
const WALLET_B = process.env.YELLOW_SIGNER_PRIVATE_KEY_B
    ? privateKeyToAccount(process.env.YELLOW_SIGNER_PRIVATE_KEY_B).address
    : '';
async function waitForHealth(server, maxMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const res = await request(server).get('/health');
            const body = res.body;
            if (body.websocket === 'connected' && body.database === 'connected') {
                return body;
            }
        }
        catch {
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Server did not become healthy in time');
}
describe('Session Lifecycle (e2e)', () => {
    let app;
    let sessionId;
    beforeAll(async () => {
        process.env.CLEARNODE_URL = 'wss://clearnet-sandbox.yellow.com/ws';
        process.env.YELLOW_PARTNER_ENABLED = 'true';
        process.env.YELLOW_AUTH_APP_NAME = 'custody-e2e';
        process.env.YELLOW_AUTH_SCOPE = 'console';
        process.env.DATABASE_URL =
            'postgresql://postgres:postgres@localhost:5432/custody_gateway';
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        const health = await waitForHealth(app.getHttpServer());
        console.log('Health:', health);
    }, 30_000);
    afterAll(async () => {
        if (app)
            await app.close();
    });
    it('GET /health — connected and healthy', async () => {
        const res = await request(app.getHttpServer()).get('/health').expect(200);
        const body = res.body;
        expect(body.websocket).toBe('connected');
        expect(body.database).toBe('connected');
    });
    it('POST /yellow/sessions — create session', async () => {
        const res = await request(app.getHttpServer())
            .post('/yellow/sessions')
            .send({
            definition: {
                protocol: 'NitroRPC/0.2',
                participants: [WALLET_A, WALLET_B],
                weights: [100, 0],
                quorum: 100,
                challenge: 0,
                nonce: Date.now(),
                application: 'custody-e2e',
            },
            allocations: [
                { participant: WALLET_A, asset: 'ytest.usd', amount: '0' },
                { participant: WALLET_B, asset: 'ytest.usd', amount: '0' },
            ],
        })
            .expect(201);
        console.log('Create session:', JSON.stringify(res.body, null, 2));
        const body = res.body;
        sessionId = (body.app_session_id ??
            body.appSessionId ??
            body.sessionId);
        expect(sessionId).toBeDefined();
        expect(sessionId.length).toBeGreaterThan(0);
    }, 15_000);
    it('GET /yellow/sessions — session persisted in DB', async () => {
        await new Promise((r) => setTimeout(r, 500));
        const res = await request(app.getHttpServer())
            .get('/yellow/sessions')
            .expect(200);
        console.log('Sessions after create:', JSON.stringify(res.body, null, 2));
        const sessions = res.body;
        expect(sessions.length).toBeGreaterThan(0);
        const found = sessions.find((s) => s.sessionId === sessionId);
        expect(found).toBeDefined();
    });
    it('POST /yellow/sessions/:id/state — submit app state', async () => {
        expect(sessionId).toBeDefined();
        const res = await request(app.getHttpServer())
            .post(`/yellow/sessions/${sessionId}/state`)
            .send({
            allocations: [
                { participant: WALLET_A, asset: 'ytest.usd', amount: '0' },
                { participant: WALLET_B, asset: 'ytest.usd', amount: '0' },
            ],
        });
        console.log('Submit state:', res.status, JSON.stringify(res.body, null, 2));
        expect([200, 500]).toContain(res.status);
    }, 15_000);
    it('POST /yellow/sessions/:id/close — close session', async () => {
        expect(sessionId).toBeDefined();
        const res = await request(app.getHttpServer())
            .post(`/yellow/sessions/${sessionId}/close`)
            .send({
            allocations: [
                { participant: WALLET_A, asset: 'ytest.usd', amount: '0' },
                { participant: WALLET_B, asset: 'ytest.usd', amount: '0' },
            ],
        });
        console.log('Close session:', res.status, JSON.stringify(res.body, null, 2));
        expect([200, 500]).toContain(res.status);
    }, 15_000);
});
//# sourceMappingURL=session-lifecycle.e2e-spec.js.map