import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ActivateInstagramIntegrationService, buildApiInboxName, buildAvailableApiInboxName, missingLinkageFields } from '../src/application/activateInstagramIntegration';
import { AppModule } from '../src/app.module';
import { EnvironmentConfig } from '../src/config/environment';
import { IntegrationStatus } from '../src/domain/integrationStatus';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../src/infrastructure/chatwoot/chatwoot.client';
import { applyTestEnvironment } from './test-env';

describe('ActivateInstagramIntegrationService', () => {
  it('returns active with existing linkage and avoids duplicate provisioning calls', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [{ id: 11, version: 1, chatwootAccountId: 42, chatwootInboxId: 100, chatwootChannelId: 200 }],
    });
    const chatwoot = chatwootMock({ accountId: 42 });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toEqual({
      status: IntegrationStatus.Active,
      agentId: 7,
      instagramAccountId: 11,
      chatwootAccountId: 42,
      chatwootInboxId: 100,
      chatwootChannelId: 200,
    });

    expect(axelor.login).toHaveBeenCalledTimes(1);
    expect(axelor.login.mock.invocationCallOrder[0]).toBeLessThan(axelor.fetchAgent.mock.invocationCallOrder[0]);
    expect(chatwoot.getProfile).not.toHaveBeenCalled();
    expect(chatwoot.listInboxes).not.toHaveBeenCalled();
    expect(chatwoot.createApiInbox).not.toHaveBeenCalled();
    expect(axelor.updateInstagramAccount).not.toHaveBeenCalled();
  });

  it('uses stored chatwootAccountId for provisioning without resolving Chatwoot profile', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3, chatwootAccountId: 49 })],
    });
    const chatwoot = chatwootMock({
      accountId: 42,
      createdInbox: { id: 101, channel_id: 201, name: 'Instagram Account 11 IG', channel_type: 'Channel::Api' },
    });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toMatchObject({
      status: IntegrationStatus.Active,
      chatwootAccountId: 49,
      chatwootInboxId: 101,
      chatwootChannelId: 201,
    });

    expect(chatwoot.getProfile).not.toHaveBeenCalled();
    expect(chatwoot.listInboxes).toHaveBeenCalledWith(49, 'agent-secret');
    expect(chatwoot.createApiInbox).toHaveBeenCalledWith(49, 'agent-secret', { name: 'Instagram Account 11 IG' });
  });

  it('falls back to Chatwoot profile when stored chatwootAccountId is missing or invalid', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3, chatwootAccountId: 0 })],
    });
    const chatwoot = chatwootMock({ accountId: 42 });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toMatchObject({
      status: IntegrationStatus.Active,
      chatwootAccountId: 42,
    });

    expect(chatwoot.getProfile).toHaveBeenCalledWith('agent-secret');
    expect(chatwoot.listInboxes).toHaveBeenCalledWith(42, 'agent-secret');
  });

  it('treats zero Chatwoot linkage IDs as absent instead of reusable linkage', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3, chatwootAccountId: 49, chatwootInboxId: 0, chatwootChannelId: 0 })],
    });
    const chatwoot = chatwootMock({
      createdInbox: { id: 101, channel_id: 201, name: 'Instagram Account 11 IG', channel_type: 'Channel::Api' },
    });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toMatchObject({
      status: IntegrationStatus.Active,
      chatwootAccountId: 49,
      chatwootInboxId: 101,
      chatwootChannelId: 201,
    });

    expect(chatwoot.getProfile).not.toHaveBeenCalled();
    expect(chatwoot.createApiInbox).toHaveBeenCalledWith(49, 'agent-secret', { name: 'Instagram Account 11 IG' });
    expect(axelor.updateInstagramAccount).toHaveBeenCalledTimes(1);
    expect(axelor.readInstagramAccount).toHaveBeenCalledWith(11);
  });

  it('returns failed when Agent does not have a Chatwoot API token', async () => {
    const axelor = axelorMock({ agent: { id: 7 }, instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3 })] });
    const chatwoot = chatwootMock();
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toEqual({
      status: IntegrationStatus.Failed,
      agentId: 7,
      instagramAccountId: 11,
      reason: 'missing_agent_chatwoot_api_key',
    });

    expect(chatwoot.getProfile).not.toHaveBeenCalled();
    expect(axelor.updateInstagramAccount).toHaveBeenCalledWith(
      11,
      3,
      expect.objectContaining({
        chatwootIntegrationStatus: IntegrationStatus.Failed,
        chatwootLastIntegrationError: 'missing_agent_chatwoot_api_key',
      }),
    );
  });

  it('returns failed when InstagramAccount is missing', async () => {
    const axelor = axelorMock({ agent: { id: 7, chatwootApiKey: 'agent-secret' }, instagramAccounts: [] });
    const chatwoot = chatwootMock();
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toEqual({
      status: IntegrationStatus.Failed,
      agentId: 7,
      reason: 'instagram_account_not_found',
    });

    expect(chatwoot.getProfile).not.toHaveBeenCalled();
  });

  it('returns schema_gap and avoids unsafe writes when linkage fields are not published', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [{ id: 11, version: 1, agent: { id: 7 } }],
    });
    const chatwoot = chatwootMock({ accountId: 42 });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toEqual({
      status: IntegrationStatus.SchemaGap,
      agentId: 7,
      instagramAccountId: 11,
      missingFields: [
        'chatwootAccountId',
        'chatwootInboxId',
        'chatwootChannelId',
        'chatwootChannelType',
        'chatwootInboxName',
        'chatwootInboxIdentifier',
        'chatwootWebhookUrl',
        'chatwootHmacToken',
        'chatwootIntegrationStatus',
        'chatwootLastSyncAt',
        'chatwootLastIntegrationError',
      ],
      proposedModelPath: 'references/ajawmrp/models/proposed/InstagramAccount.chatwoot-linkage.xml',
    });

    expect(axelor.updateInstagramAccount).not.toHaveBeenCalled();
    expect(chatwoot.listInboxes).not.toHaveBeenCalled();
    expect(chatwoot.createApiInbox).not.toHaveBeenCalled();
  });

  it('creates a consecutive Channel::Api inbox name when the base name already exists', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3 })],
    });
    const chatwoot = chatwootMock({
      accountId: 42,
      inboxes: [
        {
          id: 100,
          channel_id: 200,
          name: 'Instagram Account 11 IG',
          channel_type: 'Channel::Api',
          webhook_url: 'https://hooks.test/100',
          inbox_identifier: 'inbox-100',
          hmac_token: 'hmac-secret',
        },
      ],
      createdInbox: { id: 101, channel_id: 201, name: 'Instagram Account 11 IG 2', channel_type: 'Channel::Api', webhook_url: 'https://hooks.test/101' },
    });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toMatchObject({
      status: IntegrationStatus.Active,
      agentId: 7,
      instagramAccountId: 11,
      chatwootAccountId: 42,
      chatwootInboxId: 101,
      chatwootChannelId: 201,
    });

    expect(chatwoot.listInboxes).toHaveBeenCalledWith(42, 'agent-secret');
    expect(chatwoot.createApiInbox).toHaveBeenCalledWith(42, 'agent-secret', { name: 'Instagram Account 11 IG 2' });
    expect(axelor.updateInstagramAccount).toHaveBeenCalledWith(
      11,
      3,
      expect.objectContaining({
        chatwootAccountId: 42,
        chatwootInboxId: 101,
        chatwootChannelId: 201,
        chatwootChannelType: 'Channel::Api',
        chatwootInboxName: 'Instagram Account 11 IG 2',
        chatwootWebhookUrl: 'https://hooks.test/101',
        chatwootIntegrationStatus: IntegrationStatus.Active,
        chatwootLastIntegrationError: null,
      }),
    );
  });

  it('creates a new API inbox through the mocked path when no matching inbox exists', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3 })],
    });
    const chatwoot = chatwootMock({
      accountId: 42,
      inboxes: [{ id: 99, channel_id: 199, name: 'Other inbox', channel_type: 'Channel::Api' }],
      createdInbox: { id: 101, channel_id: 201, name: 'Instagram Account 11 IG', channel_type: 'Channel::Api', webhook_url: 'https://hooks.test/101' },
    });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toMatchObject({
      status: IntegrationStatus.Active,
      chatwootInboxId: 101,
      chatwootChannelId: 201,
    });

    expect(chatwoot.createApiInbox).toHaveBeenCalledWith(42, 'agent-secret', { name: 'Instagram Account 11 IG' });
    expect(axelor.updateInstagramAccount).toHaveBeenCalledTimes(1);
    expect(axelor.readInstagramAccount).toHaveBeenCalledWith(11);
  });

  it('persists successful provisioning linkage with published AJAWMRP field names and verifies read-back state', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3 })],
    });
    const chatwoot = chatwootMock({
      accountId: 42,
      createdInbox: {
        id: 101,
        channel_id: 201,
        name: 'Instagram Account 11 IG',
        channel_type: 'Channel::Api',
        webhook_url: 'https://hooks.test/101',
        inbox_identifier: 'inbox-101',
        hmac_token: 'hmac-secret',
      },
    });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    await expect(service.execute({ agentId: 7 })).resolves.toMatchObject({ status: IntegrationStatus.Active });

    expect(axelor.updateInstagramAccount).toHaveBeenCalledWith(
      11,
      3,
      expect.objectContaining({
        chatwootAccountId: 42,
        chatwootInboxId: 101,
        chatwootChannelId: 201,
        chatwootChannelType: 'Channel::Api',
        chatwootInboxName: 'Instagram Account 11 IG',
        chatwootInboxIdentifier: 'inbox-101',
        chatwootWebhookUrl: 'https://hooks.test/101',
        chatwootHmacToken: 'hmac-secret',
        chatwootIntegrationStatus: IntegrationStatus.Active,
        chatwootLastIntegrationError: null,
      }),
    );
    expect(axelor.readInstagramAccount).toHaveBeenCalledWith(11);
  });

  it('returns failed when InstagramAccount update response does not match read-back persistence', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3 })],
      readInstagramAccount: publishedInstagramAccount({ id: 11, version: 4, chatwootAccountId: 42, chatwootInboxId: undefined, chatwootChannelId: 201, chatwootIntegrationStatus: IntegrationStatus.Active }),
    });
    const chatwoot = chatwootMock({
      accountId: 42,
      createdInbox: { id: 101, channel_id: 201, name: 'Instagram Account 11 IG', channel_type: 'Channel::Api', hmac_token: 'hmac-secret' },
    });
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    const result = await service.execute({ agentId: 7 });

    expect(result).toEqual({
      status: IntegrationStatus.Failed,
      agentId: 7,
      instagramAccountId: 11,
      reason: 'instagram_account_persistence_failed',
    });
    expect(JSON.stringify(result)).not.toContain('agent-secret');
    expect(JSON.stringify(result)).not.toContain('hmac-secret');
    expect(axelor.updateInstagramAccount).toHaveBeenLastCalledWith(
      11,
      4,
      expect.objectContaining({
        chatwootIntegrationStatus: IntegrationStatus.Failed,
        chatwootLastIntegrationError: 'instagram_account_persistence_failed',
      }),
    );
  });

  it('persists failed provisioning errors without leaking known secrets', async () => {
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [publishedInstagramAccount({ id: 11, version: 3 })],
    });
    const chatwoot = chatwootMock({ accountId: 42 });
    chatwoot.createApiInbox.mockRejectedValueOnce(new Error('Chatwoot failed for api_access_token=agent-secret hmac_token=hmac-secret'));
    const service = new ActivateInstagramIntegrationService(axelor, chatwoot);

    const result = await service.execute({ agentId: 7 });

    expect(result).toMatchObject({ status: IntegrationStatus.Failed, agentId: 7, instagramAccountId: 11 });
    expect(JSON.stringify(result)).not.toContain('agent-secret');
    expect(JSON.stringify(result)).not.toContain('hmac-secret');
    expect(axelor.updateInstagramAccount).toHaveBeenLastCalledWith(
      11,
      3,
      expect.objectContaining({
        chatwootIntegrationStatus: IntegrationStatus.Failed,
        chatwootLastIntegrationError: expect.not.stringContaining('agent-secret'),
        chatwootLastSyncAt: expect.any(String),
      }),
    );
  });

  it('detects only truly unavailable schema fields', () => {
    expect(
      missingLinkageFields({
        id: 11,
        chatwootAccountId: undefined,
        chatwootInboxId: undefined,
        chatwootChannelId: undefined,
        chatwootChannelType: undefined,
        chatwootInboxName: undefined,
        chatwootInboxIdentifier: undefined,
        chatwootWebhookUrl: undefined,
        chatwootHmacToken: undefined,
        chatwootIntegrationStatus: undefined,
        chatwootLastSyncAt: undefined,
        chatwootLastIntegrationError: undefined,
      }),
    ).toEqual([]);
  });

  it('builds deterministic API inbox names from InstagramAccount shape', () => {
    expect(buildApiInboxName({ id: 11, name: 'Client A' })).toBe('Client A IG');
    expect(buildApiInboxName({ id: 11, username: 'client_a' })).toBe('client_a IG');
    expect(buildApiInboxName({ id: 11 })).toBe('Instagram Account 11 IG');
  });

  it('adds a consecutive suffix when an API inbox name already exists', () => {
    expect(
      buildAvailableApiInboxName({ id: 11, name: 'Client A' }, [
        { name: 'Client A IG' },
        { name: 'Client A IG 2' },
      ]),
    ).toBe('Client A IG 3');
  });
});

describe('POST /integrations/instagram/activate', () => {
  it('rejects missing internal API key without logging or returning secret values', async () => {
    applyTestEnvironment();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(configService())
      .overrideProvider(DefaultAxelorClient)
      .useValue(axelorMock())
      .overrideProvider(DefaultChatwootClient)
      .useValue(chatwootMock())
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .post('/integrations/instagram/activate')
      .send({ agentId: 7 })
      .expect(401)
      .expect(({ body }) => {
        expect(JSON.stringify(body)).not.toContain('test-internal-key');
      });

    await app.close();
  });

  it('validates agentId and returns activation results through the route', async () => {
    applyTestEnvironment();
    const axelor = axelorMock({
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
      instagramAccounts: [{ id: 11, version: 1, chatwootAccountId: 42, chatwootInboxId: 100, chatwootChannelId: 200 }],
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(configService())
      .overrideProvider(DefaultAxelorClient)
      .useValue(axelor)
      .overrideProvider(DefaultChatwootClient)
      .useValue(chatwootMock({ accountId: 42 }))
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .post('/integrations/instagram/activate')
      .set('x-internal-api-key', 'test-internal-key')
      .send({})
      .expect(400);

    await request(app.getHttpServer())
      .post('/integrations/instagram/activate')
      .set('x-internal-api-key', 'test-internal-key')
      .send({ agentId: 7 })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('active');
        expect(JSON.stringify(body)).not.toContain('agent-secret');
      });

    await app.close();
  });
});

function axelorMock(options: AxelorMockOptions = {}) {
  let currentInstagramAccount = options.instagramAccounts?.[0] ? { ...options.instagramAccounts[0] } : null;

  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    fetchAgent: jest.fn().mockResolvedValue(options.agent ?? null),
    searchInstagramAccountsByAgent: jest.fn().mockResolvedValue(options.instagramAccounts ?? []),
    updateInstagramAccount: jest.fn().mockImplementation((id: string | number, version: number, data: Record<string, unknown>) => {
      currentInstagramAccount = {
        ...(currentInstagramAccount ?? {}),
        ...data,
        id,
        version: typeof currentInstagramAccount?.version === 'number' ? currentInstagramAccount.version + 1 : version + 1,
      };

      return Promise.resolve(currentInstagramAccount);
    }),
    readInstagramAccount: jest.fn().mockImplementation(() => Promise.resolve(options.readInstagramAccount ?? currentInstagramAccount)),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function chatwootMock(options: ChatwootMockOptions = {}) {
  return {
    getProfile: jest.fn().mockResolvedValue({ account_id: options.accountId ?? 1 }),
    listInboxes: jest.fn().mockResolvedValue(options.inboxes ?? []),
    createApiInbox: jest.fn().mockResolvedValue(options.createdInbox ?? { id: 100, channel_id: 200, name: 'Instagram Account 11 IG', channel_type: 'Channel::Api' }),
  } as unknown as jest.Mocked<DefaultChatwootClient>;
}

function publishedInstagramAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    version: 1,
    chatwootAccountId: undefined,
    chatwootInboxId: undefined,
    chatwootChannelId: undefined,
    chatwootChannelType: undefined,
    chatwootInboxName: undefined,
    chatwootInboxIdentifier: undefined,
    chatwootWebhookUrl: undefined,
    chatwootHmacToken: undefined,
    chatwootIntegrationStatus: undefined,
    chatwootLastSyncAt: undefined,
    chatwootLastIntegrationError: undefined,
    ...overrides,
  };
}

interface AxelorMockOptions {
  agent?: { id: string | number; chatwootApiKey?: string } | null;
  instagramAccounts?: Array<Record<string, unknown>>;
  readInstagramAccount?: Record<string, unknown> | null;
}

interface ChatwootMockOptions {
  accountId?: number;
  inboxes?: Array<Record<string, unknown>>;
  createdInbox?: Record<string, unknown>;
}

function configService(): ConfigService<EnvironmentConfig, true> {
  return {
    get: (key: keyof EnvironmentConfig) => {
      if (key === 'INTERNAL_API_KEY') {
        return 'test-internal-key';
      }

      throw new Error(`Unexpected config key: ${String(key)}`);
    },
  } as unknown as ConfigService<EnvironmentConfig, true>;
}
