import { InstagramWebhookRoutingService, normalizeInstagramWebhookPayload } from '../src/application/instagramWebhookRouting';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../src/infrastructure/chatwoot/chatwoot.client';

describe('InstagramWebhookRoutingService', () => {
  it('normalizes common DM and comment webhook payload shapes defensively', () => {
    const events = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        { id: 'ig-account-1', messaging: [{ sender: { id: 'sender-1' }, message: { mid: 'mid-1', text: 'Hello DM' }, timestamp: 1_700_000_000 }] },
        {
          id: 'ig-account-1',
          changes: [
            {
              field: 'comments',
              value: { id: 'comment-1', text: 'Nice post', from: { id: 'sender-2', username: 'ana' }, media: { id: 'media-1', permalink: 'https://instagram.test/p/1' } },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({ kind: 'dm', instagramAccountId: 'ig-account-1', senderId: 'sender-1', sourceEventId: 'mid-1', text: 'Hello DM' }),
      expect.objectContaining({
        kind: 'comment',
        instagramAccountId: 'ig-account-1',
        senderId: 'sender-2',
        senderName: 'ana',
        sourceEventId: 'comment-1',
        publication: { id: 'media-1', url: 'https://instagram.test/p/1', caption: undefined },
      }),
    ]);
  });

  it('routes DMs to Chatwoot with deterministic identifiers', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    await expect(service.route({ payload: dmPayload() })).resolves.toEqual({
      status: 'processed',
      processed: [{ kind: 'dm', sourceEventId: 'mid-1', conversationSourceId: 'ig:dm:ig-account-1:sender-1', messageSourceId: 'ig:event:mid-1' }],
      ignored: [],
      failures: [],
    });

    expect(chatwootClient.createContact).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ identifier: 'instagram:user:sender-1' }));
    expect(chatwootClient.createContactInbox).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ source_id: 'ig:ig-account-1:user:sender-1' }));
    expect(chatwootClient.createConversation).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ source_id: 'ig:dm:ig-account-1:sender-1' }));
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 30, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('routes events when exposed Instagram scope evidence includes required scopes', async () => {
    const axelorClient = axelorMock({
      id: 11,
      chatwootAccountId: 1,
      chatwootInboxId: 100,
      scopes: ['instagram_business_manage_messages', 'instagram_manage_comments'],
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
    });
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 30, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('classifies exposed missing Instagram scopes as non-retriable without leaking tokens', async () => {
    const axelorClient = axelorMock({
      id: 11,
      chatwootAccountId: 1,
      chatwootInboxId: 100,
      accessToken: 'instagram-token-secret',
      scopes: ['instagram_business_manage_messages'],
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
    });
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    const result = await service.route({ payload: dmPayload() });

    expect(result).toEqual({
      status: 'failed',
      processed: [],
      ignored: [],
      failures: [{ sourceEventId: 'mid-1', classification: 'non_retriable', reason: 'instagram_account_required_scopes_missing' }],
    });
    expect(JSON.stringify(result)).not.toContain('instagram-token-secret');
    expect(chatwootClient.createContact).not.toHaveBeenCalled();
  });

  it('classifies downstream Chatwoot failures as retriable without marking delivery success', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.createIncomingMessage.mockRejectedValueOnce(new Error('Chatwoot create failed with token=agent-secret'));
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    await expect(service.route({ payload: dmPayload() })).resolves.toEqual({
      status: 'failed',
      processed: [],
      ignored: [],
      failures: [{ sourceEventId: 'mid-1', classification: 'retriable', reason: 'Chatwoot create failed with token=[REDACTED]' }],
    });
  });

  it('routes comments as independent conversations with visible publication context and custom attributes', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    await expect(service.route({ payload: commentPayload() })).resolves.toMatchObject({ status: 'processed' });

    expect(chatwootClient.createConversation).toHaveBeenCalledWith(
      1,
      'agent-secret',
      expect.objectContaining({
        source_id: 'ig:comment:comment-1',
        custom_attributes: expect.objectContaining({ instagram_publication_url: 'https://instagram.test/p/1' }),
      }),
    );
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(
      1,
      'agent-secret',
      30,
      expect.objectContaining({ content: 'Instagram comment on https://instagram.test/p/1\n\nNice post', source_id: 'ig:event:comment-1' }),
    );
  });

  it('classifies missing linked accounts as non-retriable and skips Chatwoot calls', async () => {
    const axelorClient = axelorMock(null);
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    await expect(service.route({ payload: dmPayload() })).resolves.toEqual({
      status: 'failed',
      processed: [],
      ignored: [],
      failures: [{ sourceEventId: 'mid-1', classification: 'non_retriable', reason: 'instagram_account_not_found' }],
    });
    expect(chatwootClient.createContact).not.toHaveBeenCalled();
  });

  it('deduplicates repeated events inside one webhook payload', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient);

    await expect(service.route({ payload: { object: 'instagram', entry: [dmPayload().entry[0], dmPayload().entry[0]] } })).resolves.toMatchObject({
      status: 'processed',
      ignored: [{ sourceEventId: 'mid-1', reason: 'duplicate_event_in_payload' }],
    });
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledTimes(1);
  });
});

function dmPayload() {
  return { object: 'instagram', entry: [{ id: 'ig-account-1', messaging: [{ sender: { id: 'sender-1' }, message: { mid: 'mid-1', text: 'Hello DM' } }] }] };
}

function commentPayload() {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'ig-account-1',
        changes: [{ field: 'comments', value: { id: 'comment-1', text: 'Nice post', from: { id: 'sender-2' }, media: { id: 'media-1', permalink: 'https://instagram.test/p/1' } } }],
      },
    ],
  };
}

function axelorMock(account: Awaited<ReturnType<DefaultAxelorClient['findInstagramAccountByInstagramUserId']>>) {
  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    findInstagramAccountByInstagramUserId: jest.fn().mockResolvedValue(account),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function chatwootMock() {
  return {
    createContact: jest.fn().mockResolvedValue({ id: 10 }),
    createContactInbox: jest.fn().mockResolvedValue({ id: 20 }),
    createConversation: jest.fn().mockResolvedValue({ id: 30 }),
    createIncomingMessage: jest.fn().mockResolvedValue({ id: 40 }),
  } as unknown as jest.Mocked<DefaultChatwootClient>;
}
