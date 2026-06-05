import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ActivateInstagramIntegrationService } from '../src/application/activateInstagramIntegration';
import { InstagramBusinessLoginService } from '../src/application/instagramBusinessLogin';
import { validateEnvironment } from '../src/config/environment';
import { IntegrationsController } from '../src/http/routes/integrations.controller';
import { applyTestEnvironment } from './test-env';

const AUTHORIZE_URL =
  'https://www.instagram.com/oauth/authorize?client_id=test-meta-app-id&redirect_uri=https%3A%2F%2Fapp.test%2Fintegrations%2Finstagram%2Fwebhook&response_type=code&scope=instagram_business_basic%20instagram_business_manage_messages%20instagram_business_manage_comments%20instagram_manage_comments%20instagram_basic&state=state-123';

describe('GET /integrations/instagram/login', () => {
  let app: INestApplication;
  let loginService: { start: jest.Mock };

  beforeEach(async () => {
    applyTestEnvironment();
    loginService = {
      start: jest.fn().mockResolvedValue({
        authorizeUrl: AUTHORIZE_URL,
        state: 'state-123',
        instagramAccountId: 11,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnvironment,
        }),
      ],
      controllers: [IntegrationsController],
      providers: [
        { provide: ActivateInstagramIntegrationService, useValue: { execute: jest.fn() } },
        { provide: InstagramBusinessLoginService, useValue: loginService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires the internal API key and redirects to the generated Instagram OAuth URL', async () => {
    await request(app.getHttpServer()).get('/integrations/instagram/login').query({ agentId: '7' }).expect(401);

    await request(app.getHttpServer())
      .get('/integrations/instagram/login')
      .set('x-internal-api-key', 'test-internal-key')
      .query({ agentId: '7' })
      .expect(302)
      .expect('Location', AUTHORIZE_URL);

    expect(loginService.start).toHaveBeenCalledWith({ agentId: '7' });
  });

  it('returns the generated Instagram OAuth URL as JSON when requested', async () => {
    await request(app.getHttpServer())
      .get('/integrations/instagram/login')
      .set('x-internal-api-key', 'test-internal-key')
      .query({ agentId: '7', response: 'json' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          authorizationUrl: AUTHORIZE_URL,
          state: 'state-123',
          agentId: '7',
          instagramAccountId: 11,
        });
      });

    expect(loginService.start).toHaveBeenCalledWith({ agentId: '7' });
  });

  it('also supports mode=json for integration tools that reserve response', async () => {
    await request(app.getHttpServer())
      .get('/integrations/instagram/login')
      .set('x-internal-api-key', 'test-internal-key')
      .query({ agentId: '7', mode: 'json' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.authorizationUrl).toBe(AUTHORIZE_URL);
      });
  });

  it('rejects missing agentId before starting OAuth login', async () => {
    await request(app.getHttpServer()).get('/integrations/instagram/login').set('x-internal-api-key', 'test-internal-key').expect(400);

    expect(loginService.start).not.toHaveBeenCalled();
  });
});
