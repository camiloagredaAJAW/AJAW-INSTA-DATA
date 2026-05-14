import { ConfigService } from '@nestjs/config';
import { EnvironmentConfig } from '../src/config/environment';
import { FetchLike } from '../src/infrastructure/axelor/axelor.client';
import { buildChatwootAuthHeaders, buildCreateApiInboxBody, DefaultChatwootClient, isChatwootApiChannelInbox } from '../src/infrastructure/chatwoot/chatwoot.client';

describe('DefaultChatwootClient', () => {
  it('sends api_access_token header and returns profile account_id', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ account_id: 42 }),
      text: async () => '{"account_id":42}',
    });
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.getProfile('chatwoot-secret')).resolves.toEqual({ account_id: 42 });

    expect(fetcher).toHaveBeenCalledWith('https://chatwoot.test/api/v1/profile', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        api_access_token: 'chatwoot-secret',
      },
    });
  });

  it('lists inboxes and parses API Channel fields without requiring real Chatwoot calls', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        payload: [
          {
            id: 100,
            channel_id: 200,
            name: 'Instagram Account 11',
            channel_type: 'Channel::Api',
            webhook_url: 'https://chatwoot.test/webhooks/abc',
            inbox_identifier: 'inbox-abc',
            hmac_token: 'hmac-secret',
          },
        ],
      }),
      text: async () => '',
    });
    const client = new DefaultChatwootClient(configService(), fetcher);

    expect(buildChatwootAuthHeaders('token')).toEqual({ Accept: 'application/json', api_access_token: 'token' });

    await expect(client.listInboxes(1, 'token')).resolves.toEqual([
      {
        id: 100,
        channel_id: 200,
        name: 'Instagram Account 11',
        channel_type: 'Channel::Api',
        webhook_url: 'https://chatwoot.test/webhooks/abc',
        inbox_identifier: 'inbox-abc',
        hmac_token: 'hmac-secret',
      },
    ]);
    expect(isChatwootApiChannelInbox({ id: 100, channel_type: 'Channel::Api' })).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://chatwoot.test/api/v1/accounts/1/inboxes', {
      method: 'GET',
      headers: { Accept: 'application/json', api_access_token: 'token' },
    });
  });

  it('creates an API Channel inbox with channel.type api and no web widget fields by default', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: 101, channel_id: 201, name: 'Instagram Account 11', channel_type: 'Channel::Api' }),
      text: async () => '',
    });
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.createApiInbox(1, 'token', { name: 'Instagram Account 11' })).resolves.toEqual({
      id: 101,
      channel_id: 201,
      name: 'Instagram Account 11',
      channel_type: 'Channel::Api',
      webhook_url: undefined,
      inbox_identifier: undefined,
      hmac_token: undefined,
    });
    expect(buildCreateApiInboxBody({ name: 'Instagram Account 11' })).toEqual({
      name: 'Instagram Account 11',
      channel: { type: 'api' },
    });
    expect(fetcher).toHaveBeenCalledWith('https://chatwoot.test/api/v1/accounts/1/inboxes', {
      method: 'POST',
      headers: { Accept: 'application/json', api_access_token: 'token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Instagram Account 11', channel: { type: 'api' } }),
    });
  });

  it('fails with a non-secret diagnostic when profile account_id is absent', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ user: 'agent' }),
      text: async () => '{}',
    });
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.getProfile('secret-token')).rejects.toThrow('account_id');
    await expect(client.getProfile('secret-token')).rejects.not.toThrow('secret-token');
  });
});

function configService(): ConfigService<EnvironmentConfig, true> {
  return {
    get: (key: keyof EnvironmentConfig) => {
      if (key === 'CHATWOOT_BASE_URL') {
        return 'https://chatwoot.test';
      }

      throw new Error(`Unexpected config key: ${String(key)}`);
    },
  } as unknown as ConfigService<EnvironmentConfig, true>;
}
