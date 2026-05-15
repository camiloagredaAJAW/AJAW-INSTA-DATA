import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { validateEnvironment } from '../src/config/environment';
import { InstagramWebhookController } from '../src/http/routes/instagram-webhook.controller';
import { applyTestEnvironment } from './test-env';

describe('InstagramWebhookController', () => {
  let app: INestApplication;

  beforeEach(async () => {
    applyTestEnvironment();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnvironment,
        }),
      ],
      controllers: [InstagramWebhookController],
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

  it('accepts a POST request with a valid Meta signature', async () => {
    const payload = JSON.stringify({ object: 'instagram', entry: [] });
    const signature = sign(payload);

    await request(app.getHttpServer())
      .post('/integrations/instagram/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(payload)
      .expect(200)
      .expect({ status: 'ok' });
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
  });
});

function sign(payload: string): string {
  const digest = createHmac('sha256', 'test-meta-app-secret').update(Buffer.from(payload)).digest('hex');
  return `sha256=${digest}`;
}
