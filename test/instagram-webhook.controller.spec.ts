import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { InstagramBusinessLoginService } from '../src/application/instagramBusinessLogin';
import { InstagramWebhookRoutingService } from '../src/application/instagramWebhookRouting';
import { validateEnvironment } from '../src/config/environment';
import { InstagramWebhookController } from '../src/http/routes/instagram-webhook.controller';
import { applyTestEnvironment } from './test-env';

describe('InstagramWebhookController', () => {
  let app: INestApplication;
  let loginService: { completeCallback: jest.Mock };
  let routingService: { route: jest.Mock };

  beforeEach(async () => {
    applyTestEnvironment();
    loginService = {
      completeCallback: jest.fn().mockResolvedValue({
        status: 'connected',
        instagramAccountId: 11,
        instagramUserId: '17841400000000000',
        tokenSource: 'short_lived',
        longLivedTokenExchange: { attempted: false, succeeded: false },
      }),
    };
    routingService = {
      route: jest.fn().mockResolvedValue({ status: 'processed', processed: [], ignored: [], failures: [] }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnvironment,
        }),
      ],
      controllers: [InstagramWebhookController],
      providers: [
        { provide: InstagramBusinessLoginService, useValue: loginService },
        { provide: InstagramWebhookRoutingService, useValue: routingService },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the raw Meta challenge for a valid verification request', async () => {
    await request(app.getHttpServer())
      .get('/integrations/instagram/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-webhook-verify-token',
        'hub.challenge': 'challenge-123',
      })
      .expect(200)
      .expect('challenge-123');
  });

  it('rejects invalid verification requests', async () => {
    await request(app.getHttpServer())
      .get('/integrations/instagram/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-123',
      })
      .expect(401)
      .expect(({ text }) => {
        expect(text).not.toContain('test-webhook-verify-token');
      });

    await request(app.getHttpServer())
      .get('/integrations/instagram/webhook')
      .query({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'test-webhook-verify-token',
        'hub.challenge': 'challenge-123',
      })
      .expect(401);
  });

  it('routes OAuth callback GET requests through the login service without running verification', async () => {
    await request(app.getHttpServer())
      .get('/integrations/instagram/webhook')
      .query({ code: 'code-123', state: 'state-123' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ status: 'connected', instagramAccountId: 11, tokenSource: 'short_lived' });
        expect(JSON.stringify(body)).not.toContain('token-secret');
      });

    expect(loginService.completeCallback).toHaveBeenCalledWith({ code: 'code-123', state: 'state-123' });
    expect(routingService.route).not.toHaveBeenCalled();
  });

  it('rejects invalid GET requests that are neither verification nor OAuth callback', async () => {
    await request(app.getHttpServer()).get('/integrations/instagram/webhook').query({ code: 'code-without-state' }).expect(400);

    expect(loginService.completeCallback).not.toHaveBeenCalled();
    expect(routingService.route).not.toHaveBeenCalled();
  });

  it('delegates a POST request with a valid Meta signature to the routing service', async () => {
    const payload = JSON.stringify({ object: 'instagram', entry: [] });
    const signature = sign(payload);

    await request(app.getHttpServer())
      .post('/integrations/instagram/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(payload)
      .expect(200)
      .expect({ status: 'processed', processed: [], ignored: [], failures: [] });

    expect(routingService.route).toHaveBeenCalledWith({ payload: { object: 'instagram', entry: [] } });
  });

  it('rejects POST requests with missing or invalid Meta signatures', async () => {
    const payload = JSON.stringify({ object: 'instagram', entry: [] });

    await request(app.getHttpServer())
      .post('/integrations/instagram/webhook')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(401)
      .expect(({ text }) => {
        expect(text).not.toContain('test-meta-app-secret');
      });

    await request(app.getHttpServer())
      .post('/integrations/instagram/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(JSON.stringify({ tampered: true })))
      .send(payload)
      .expect(401);

    expect(routingService.route).not.toHaveBeenCalled();
  });
});

function sign(payload: string): string {
  const digest = createHmac('sha256', 'test-meta-app-secret').update(Buffer.from(payload)).digest('hex');
  return `sha256=${digest}`;
}
