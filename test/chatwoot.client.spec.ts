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
      json: async () => ({ account_id: 42, accounts: [{ id: 42, name: 'AJAW AI' }] }),
      text: async () => '{"account_id":42,"accounts":[{"id":42,"name":"AJAW AI"}]}',
    });
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.getProfile('chatwoot-secret')).resolves.toEqual({ account_id: 42, accounts: [{ id: 42, name: 'AJAW AI' }] });

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

  it('creates contact, contact_inbox, conversation, and incoming message with deterministic source ids', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(response({ body: { payload: { id: 10, identifier: 'instagram:user:sender-1' } } }))
      .mockResolvedValueOnce(response({ body: { id: 20, source_id: 'ig:account-1:user:sender-1' } }))
      .mockResolvedValueOnce(response({ body: { id: 30, source_id: 'ig:dm:account-1:sender-1' } }))
      .mockResolvedValueOnce(response({ body: { id: 40, source_id: 'ig:event:mid-1' } }));
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(
      client.createContact(1, 'token', {
        inbox_id: 100,
        identifier: 'instagram:user:sender-1',
        name: 'Instagram user sender-1',
        additional_attributes: { instagram_sender_id: 'sender-1' },
      }),
    ).resolves.toEqual({ id: 10, identifier: 'instagram:user:sender-1', source_id: undefined });
    await expect(client.createContactInbox(1, 'token', { contact_id: 10, inbox_id: 100, source_id: 'ig:account-1:user:sender-1' })).resolves.toEqual({
      id: 20,
      source_id: 'ig:account-1:user:sender-1',
      identifier: undefined,
    });
    await expect(client.createConversation(1, 'token', { inbox_id: 100, contact_id: 10, source_id: 'ig:dm:account-1:sender-1' })).resolves.toEqual({
      id: 30,
      source_id: 'ig:dm:account-1:sender-1',
      identifier: undefined,
    });
    await expect(client.createIncomingMessage(1, 'token', 30, { content: 'Hello', source_id: 'ig:event:mid-1' })).resolves.toEqual({
      id: 40,
      source_id: 'ig:event:mid-1',
      identifier: undefined,
    });

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'https://chatwoot.test/api/v1/accounts/1/contacts',
      'https://chatwoot.test/api/v1/accounts/1/contacts/10/contact_inboxes',
      'https://chatwoot.test/api/v1/accounts/1/conversations',
      'https://chatwoot.test/api/v1/accounts/1/conversations/30/messages',
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({ content: 'Hello', source_id: 'ig:event:mid-1', message_type: 'incoming' });
  });

  it('searches contacts and preserves contact inbox links', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { payload: [{ id: 10, identifier: 'instagram:user:sender-1', contact_inboxes: [{ source_id: 'ig:account-1:user:sender-1', inbox: { id: 100 } }] }] } }),
    );
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.searchContacts(1, 'token', 'instagram:user:sender-1')).resolves.toEqual([
      { id: 10, identifier: 'instagram:user:sender-1', contact_inboxes: [{ source_id: 'ig:account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    expect(fetcher.mock.calls[0][0]).toBe('https://chatwoot.test/api/v1/accounts/1/contacts/search?q=instagram%3Auser%3Asender-1');
  });

  it('creates contact inboxes through the nested Chatwoot contact endpoint', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { source_id: 'ig:account-1:user:sender-1', inbox: { id: 100 } } }),
    );
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.createContactInbox(1, 'token', { contact_id: 10, inbox_id: 100, source_id: 'ig:account-1:user:sender-1' })).resolves.toEqual({
      id: undefined,
      source_id: 'ig:account-1:user:sender-1',
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://chatwoot.test/api/v1/accounts/1/contacts/10/contact_inboxes');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ inbox_id: 100, source_id: 'ig:account-1:user:sender-1' });
  });

  it('reports non-secret Chatwoot endpoint diagnostics for failed API requests', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(response({ ok: false, status: 404, body: {} }));
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(client.createConversation(1, 'secret-token', { inbox_id: 100, contact_id: 10, source_id: 'ig:dm:account-1:sender-1' })).rejects.toThrow(
      'Chatwoot API request failed: method=POST path=/api/v1/accounts/1/conversations status=404',
    );
    await expect(client.createConversation(1, 'secret-token', { inbox_id: 100, contact_id: 10, source_id: 'ig:dm:account-1:sender-1' })).rejects.not.toThrow(
      'secret-token',
    );
  });

  it('accepts Chatwoot contact create responses that wrap the contact in a payload array', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { payload: [{ id: 10, identifier: 'instagram:user:sender-1' }] } }),
    );
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(
      client.createContact(1, 'token', {
        inbox_id: 100,
        identifier: 'instagram:user:sender-1',
        name: 'Instagram user sender-1',
        additional_attributes: { instagram_sender_id: 'sender-1' },
      }),
    ).resolves.toEqual({ id: 10, identifier: 'instagram:user:sender-1', source_id: undefined });
  });

  it('accepts Chatwoot contact create responses that wrap the contact object under payload.contact', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { payload: { contact: { id: 10, identifier: 'instagram:user:sender-1' } } } }),
    );
    const client = new DefaultChatwootClient(configService(), fetcher);

    await expect(
      client.createContact(1, 'token', {
        inbox_id: 100,
        identifier: 'instagram:user:sender-1',
        name: 'Instagram user sender-1',
        additional_attributes: { instagram_sender_id: 'sender-1' },
      }),
    ).resolves.toEqual({ id: 10, identifier: 'instagram:user:sender-1', source_id: undefined });
  });
});

function response({ ok = true, status = 200, body = {} }: { ok?: boolean; status?: number; body?: unknown }) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

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
