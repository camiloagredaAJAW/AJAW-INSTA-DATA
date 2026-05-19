import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { IntegrationStatus } from '../src/domain/integrationStatus';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../src/infrastructure/chatwoot/chatwoot.client';
import { applyTestEnvironment } from './test-env';

describe('App foundation', () => {
  let app: INestApplication;
  let axelorClient: {
    login: jest.Mock;
    findInstagramAccountByInstagramUserId: jest.Mock;
  };
  let chatwootClient: {
    searchContacts: jest.Mock;
    createContact: jest.Mock;
    createContactInbox: jest.Mock;
    listContactConversations: jest.Mock;
    createConversation: jest.Mock;
    createIncomingMessage: jest.Mock;
  };

  beforeAll(async () => {
    applyTestEnvironment();
    const { AppModule } = await import('../src/app.module');
    axelorClient = {
      login: jest.fn().mockResolvedValue({ jsessionId: 'test-session' }),
      findInstagramAccountByInstagramUserId: jest.fn().mockResolvedValue({
        id: 7,
        instagramUserId: '17841400000000000',
        chatwootAccountId: 49,
        chatwootInboxId: 72,
        chatwootIntegrationStatus: IntegrationStatus.Active,
        scopes: ['instagram_business_manage_messages', 'instagram_manage_comments'],
        agent: { id: 1, chatwootApiKey: 'test-chatwoot-api-key' },
      }),
    };
    chatwootClient = {
      searchContacts: jest.fn().mockResolvedValue([]),
      createContact: jest.fn().mockResolvedValue({ id: 101, identifier: 'instagram:user:123456789' }),
      createContactInbox: jest.fn().mockResolvedValue({ id: 202, source_id: 'ig:17841400000000000:user:123456789' }),
      listContactConversations: jest.fn().mockResolvedValue([]),
      createConversation: jest.fn().mockResolvedValue({ id: 303, source_id: 'ig:dm:17841400000000000:123456789' }),
      createIncomingMessage: jest.fn().mockResolvedValue({ id: 404, source_id: 'ig:event:m_abc123' }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DefaultAxelorClient)
      .useValue(axelorClient)
      .overrideProvider(DefaultChatwootClient)
      .useValue(chatwootClient)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots and exposes a non-secret health response', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          status: 'ok',
          service: 'ajaw-insta-data',
          environment: 'test',
        });
        expect(JSON.stringify(body)).not.toContain('test-internal-key');
        expect(JSON.stringify(body)).not.toContain('test-password');
      });
  });

  it('accepts a signed Instagram DM webhook and routes it through AppModule providers', async () => {
    const payload = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: '17841400000000000',
          messaging: [
            {
              sender: { id: '123456789' },
              timestamp: 1_716_204_800,
              message: { mid: 'm_abc123', text: 'Hello from Instagram' },
            },
          ],
        },
      ],
    });

    await request(app.getHttpServer())
      .post('/integrations/instagram/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(payload))
      .send(payload)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'processed',
          processed: [
            {
              kind: 'dm',
              sourceEventId: 'm_abc123',
              conversationSourceId: 'ig:17841400000000000:user:123456789',
              messageSourceId: 'ig:event:m_abc123',
            },
          ],
          ignored: [],
          failures: [],
        });
      });

    expect(axelorClient.findInstagramAccountByInstagramUserId).toHaveBeenCalledWith('17841400000000000');
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(
      49,
      'test-chatwoot-api-key',
      303,
      expect.objectContaining({
        content: 'Hello from Instagram',
        source_id: 'ig:event:m_abc123',
      }),
    );
  });
});

function sign(payload: string): string {
  const digest = createHmac('sha256', 'test-meta-app-secret').update(Buffer.from(payload)).digest('hex');
  return `sha256=${digest}`;
}
