import { InstagramWebhookRoutingService, normalizeInstagramWebhookPayload } from '../src/application/instagramWebhookRouting';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../src/infrastructure/chatwoot/chatwoot.client';
import { InstagramOAuthClient } from '../src/infrastructure/meta/instagram-oauth.client';

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
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const instagramOAuthClient = oauthMock({ name: 'Peter Chang', username: 'peter_chang_live', profilePic: 'https://profile.test/peter.jpg' });
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, instagramOAuthClient);

    await expect(service.route({ payload: dmPayload() })).resolves.toEqual({
      status: 'processed',
      processed: [{ kind: 'dm', sourceEventId: 'mid-1', conversationSourceId: 'ig:ig-account-1:user:sender-1', messageSourceId: 'ig:event:mid-1' }],
      ignored: [],
      failures: [],
    });

    expect(chatwootClient.searchContacts).toHaveBeenCalledWith(1, 'agent-secret', 'instagram:user:sender-1');
    expect(instagramOAuthClient.fetchMessagingUserProfile).toHaveBeenCalledWith('sender-1', 'instagram-token');
    expect(chatwootClient.createContact).toHaveBeenCalledWith(
      1,
      'agent-secret',
      expect.objectContaining({
        inbox_id: 100,
        identifier: 'instagram:user:sender-1',
        name: 'Peter Chang',
        avatar_url: 'https://profile.test/peter.jpg',
        additional_attributes: expect.objectContaining({ instagram_username: 'peter_chang_live', instagram_name: 'Peter Chang' }),
      }),
    );
    expect(chatwootClient.createContactInbox).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ source_id: 'ig:ig-account-1:user:sender-1' }));
    expect(chatwootClient.createConversation).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ source_id: 'ig:ig-account-1:user:sender-1' }));
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
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 30, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('reuses an existing Chatwoot contact and contact inbox when the sender was already created', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.createContact).not.toHaveBeenCalled();
    expect(chatwootClient.createContactInbox).not.toHaveBeenCalled();
    expect(chatwootClient.createConversation).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ contact_id: 10 }));
  });

  it('adds new DM messages to the existing open Chatwoot conversation for the same contact and inbox', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', name: 'Peter Chang', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    chatwootClient.listContactConversations.mockResolvedValueOnce([{ id: 55, inbox_id: 100, status: 'open', source_id: 'ig:ig-account-1:user:sender-1' }]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.createConversation).not.toHaveBeenCalled();
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 55, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('reuses existing DM conversations when Chatwoot only exposes the deterministic source through contact_inbox', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', name: 'Peter Chang', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    chatwootClient.listContactConversations.mockResolvedValueOnce([
      { id: 55, inbox_id: 100, status: 'open', contact_inbox: { source_id: 'ig:ig-account-1:user:sender-1' } },
    ]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.createConversation).not.toHaveBeenCalled();
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 55, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('reuses existing DM conversations by Instagram custom attributes when Chatwoot omits source_id', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', name: 'Peter Chang', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    chatwootClient.listContactConversations.mockResolvedValueOnce([
      { id: 55, inbox_id: 100, status: 'open', custom_attributes: { instagram_event_kind: 'dm', instagram_account_id: 'ig-account-1', instagram_sender_id: 'sender-1' } },
    ]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.createConversation).not.toHaveBeenCalled();
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 55, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('does not reuse Chatwoot UUID contact inbox source ids as Instagram DM conversation source ids', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', contact_inboxes: [{ id: 20, source_id: '5ea4156f-83f0-4a81-bc1b-7a0271a63e2c', inbox: { id: 100 } }] },
    ]);
    chatwootClient.listContactConversations.mockResolvedValueOnce([{ id: 55, inbox_id: 100, status: 'open', source_id: '5ea4156f-83f0-4a81-bc1b-7a0271a63e2c' }]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toEqual({
      status: 'processed',
      processed: [{ kind: 'dm', sourceEventId: 'mid-1', conversationSourceId: 'ig:ig-account-1:user:sender-1', messageSourceId: 'ig:event:mid-1' }],
      ignored: [],
      failures: [],
    });

    expect(chatwootClient.createContactInbox).toHaveBeenCalledWith(
      1,
      'agent-secret',
      expect.objectContaining({ contact_id: 10, inbox_id: 100, source_id: 'ig:ig-account-1:user:sender-1' }),
    );
    expect(chatwootClient.createConversation).toHaveBeenCalledWith(
      1,
      'agent-secret',
      expect.objectContaining({ source_id: 'ig:ig-account-1:user:sender-1', contact_inbox_id: 20 }),
    );
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(1, 'agent-secret', 30, expect.objectContaining({ source_id: 'ig:event:mid-1' }));
  });

  it('routes Instagram echo messages as outgoing messages for the recipient contact', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', name: 'Peter Chang', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    chatwootClient.listContactConversations.mockResolvedValueOnce([{ id: 55, inbox_id: 100, status: 'open', source_id: 'ig:ig-account-1:user:sender-1' }]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: outgoingDmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.searchContacts).toHaveBeenCalledWith(1, 'agent-secret', 'instagram:user:sender-1');
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(
      1,
      'agent-secret',
      55,
      expect.objectContaining({ content: 'hola muy bien', message_type: 'outgoing', source_id: 'ig:event:mid-out-1' }),
    );
  });

  it('ignores Instagram echo messages that match a recent Chatwoot outbound send by recipient and text', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const outboundMessages = { wasSentByThisService: jest.fn().mockReturnValue(false), wasRecentlySentByThisService: jest.fn().mockReturnValue(true) };
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock(), outboundMessages as never);

    await expect(service.route({ payload: outgoingDmPayload() })).resolves.toEqual({
      status: 'ignored',
      processed: [],
      ignored: [{ sourceEventId: 'mid-out-1', reason: 'echo_of_chatwoot_outbound' }],
      failures: [],
    });

    expect(outboundMessages.wasRecentlySentByThisService).toHaveBeenCalledWith('sender-1', 'hola muy bien');
    expect(chatwootClient.createIncomingMessage).not.toHaveBeenCalled();
  });

  it('updates an existing generic Chatwoot contact with Instagram sender profile details', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-1', name: 'Instagram user sender-1', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-1', inbox: { id: 100 } }] },
    ]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock({ name: 'Peter Chang', username: 'peter_chang_live', profilePic: 'https://profile.test/peter.jpg' }));

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.updateContact).toHaveBeenCalledWith(
      1,
      'agent-secret',
      10,
      expect.objectContaining({ name: 'Peter Chang', avatar_url: 'https://profile.test/peter.jpg' }),
    );
    expect(chatwootClient.createConversation).toHaveBeenCalledWith(1, 'agent-secret', expect.objectContaining({ source_id: 'ig:ig-account-1:user:sender-1' }));
  });

  it('fetches the Agent when webhook search does not expand chatwootApiKey', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, agent: { id: 7 } }, { id: 7, chatwootApiKey: 'agent-secret' });
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(axelorClient.fetchAgent).toHaveBeenCalledWith(7);
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
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

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
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

    await expect(service.route({ payload: dmPayload() })).resolves.toEqual({
      status: 'failed',
      processed: [],
      ignored: [],
      failures: [{ sourceEventId: 'mid-1', classification: 'retriable', reason: 'Chatwoot create failed with token=[REDACTED]' }],
    });
  });

  it('routes comments into the Instagram user conversation with visible publication context and custom attributes', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const instagramOAuthClient = oauthMock({}, { id: 'media-1', permalink: 'https://instagram.test/p/1', caption: 'Post caption', mediaUrl: 'https://instagram.test/media.jpg' });
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, instagramOAuthClient);

    await expect(service.route({ payload: commentPayloadWithoutPermalink() })).resolves.toMatchObject({ status: 'processed' });

    expect(instagramOAuthClient.fetchMediaReference).toHaveBeenCalledWith('media-1', 'instagram-token');
    expect(chatwootClient.createConversation).toHaveBeenCalledWith(
      1,
      'agent-secret',
      expect.objectContaining({
        source_id: 'ig:ig-account-1:user:sender-2',
        custom_attributes: expect.objectContaining({ instagram_publication_url: 'https://instagram.test/p/1', instagram_publication_caption: 'Post caption' }),
      }),
    );
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(
      1,
      'agent-secret',
      30,
      expect.objectContaining({
        content: 'Instagram comment on https://instagram.test/p/1\n\nNice post',
        source_id: 'ig:event:comment-1',
        content_attributes: expect.objectContaining({ instagram_publication_url: 'https://instagram.test/p/1', instagram_media_url: 'https://instagram.test/media.jpg' }),
      }),
    );
  });

  it('adds comment events to an existing DM conversation for the same Instagram user and inbox', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    chatwootClient.searchContacts.mockResolvedValueOnce([
      { id: 10, identifier: 'instagram:user:sender-2', contact_inboxes: [{ source_id: 'ig:ig-account-1:user:sender-2', inbox: { id: 100 } }] },
    ]);
    chatwootClient.listContactConversations.mockResolvedValueOnce([{ id: 55, inbox_id: 100, status: 'open', source_id: 'ig:ig-account-1:user:sender-2' }]);
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock({}, { id: 'media-1', permalink: 'https://instagram.test/p/1' }));

    await expect(service.route({ payload: commentPayloadWithoutPermalink() })).resolves.toEqual({
      status: 'processed',
      processed: [{ kind: 'comment', sourceEventId: 'comment-1', conversationSourceId: 'ig:ig-account-1:user:sender-2', messageSourceId: 'ig:event:comment-1' }],
      ignored: [],
      failures: [],
    });

    expect(chatwootClient.createConversation).not.toHaveBeenCalled();
    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(
      1,
      'agent-secret',
      55,
      expect.objectContaining({ content: 'Instagram comment on https://instagram.test/p/1\n\nNice post', source_id: 'ig:event:comment-1' }),
    );
  });

  it('keeps comment media id as fallback when publication permalink lookup is unavailable', async () => {
    const axelorClient = axelorMock({ id: 11, chatwootAccountId: 1, chatwootInboxId: 100, accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const instagramOAuthClient = oauthMock();
    instagramOAuthClient.fetchMediaReference.mockRejectedValueOnce(new Error('Graph token=instagram-token failed'));
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, instagramOAuthClient);

    await expect(service.route({ payload: commentPayloadWithoutPermalink() })).resolves.toMatchObject({ status: 'processed', failures: [] });

    expect(chatwootClient.createIncomingMessage).toHaveBeenCalledWith(
      1,
      'agent-secret',
      30,
      expect.objectContaining({ content: 'Instagram comment on media-1\n\nNice post', source_id: 'ig:event:comment-1' }),
    );
  });

  it('normalizes Instagram echo webhook payloads as outgoing DMs for the recipient user', () => {
    expect(normalizeInstagramWebhookPayload(outgoingDmPayload())).toEqual([
      expect.objectContaining({ direction: 'outgoing', senderId: 'sender-1', sourceEventId: 'mid-out-1', text: 'hola muy bien' }),
    ]);
  });

  it('classifies missing linked accounts as non-retriable and skips Chatwoot calls', async () => {
    const axelorClient = axelorMock(null);
    const chatwootClient = chatwootMock();
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

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
    const service = new InstagramWebhookRoutingService(axelorClient, chatwootClient, oauthMock());

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

function outgoingDmPayload() {
  return {
    object: 'instagram',
    entry: [{ id: 'ig-account-1', messaging: [{ sender: { id: 'ig-account-1' }, recipient: { id: 'sender-1' }, message: { mid: 'mid-out-1', text: 'hola muy bien', is_echo: true } }] }],
  };
}

function commentPayloadWithoutPermalink() {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'ig-account-1',
        changes: [{ field: 'comments', value: { id: 'comment-1', text: 'Nice post', from: { id: 'sender-2' }, media: { id: 'media-1' } } }],
      },
    ],
  };
}

function axelorMock(
  account: Awaited<ReturnType<DefaultAxelorClient['findInstagramAccountByInstagramUserId']>>,
  agent: Awaited<ReturnType<DefaultAxelorClient['fetchAgent']>> = null,
) {
  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    findInstagramAccountByInstagramUserId: jest.fn().mockResolvedValue(account),
    fetchAgent: jest.fn().mockResolvedValue(agent),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function chatwootMock() {
  return {
    searchContacts: jest.fn().mockResolvedValue([]),
    createContact: jest.fn().mockResolvedValue({ id: 10 }),
    updateContact: jest.fn().mockResolvedValue(undefined),
    createContactInbox: jest.fn().mockResolvedValue({ id: 20 }),
    listContactConversations: jest.fn().mockResolvedValue([]),
    createConversation: jest.fn().mockResolvedValue({ id: 30 }),
    createIncomingMessage: jest.fn().mockResolvedValue({ id: 40 }),
  } as unknown as jest.Mocked<DefaultChatwootClient>;
}

function oauthMock(
  profile: Awaited<ReturnType<InstagramOAuthClient['fetchMessagingUserProfile']>> = {},
  media: Awaited<ReturnType<InstagramOAuthClient['fetchMediaReference']>> = {},
) {
  return {
    fetchMessagingUserProfile: jest.fn().mockResolvedValue(profile),
    fetchMediaReference: jest.fn().mockResolvedValue(media),
  } as unknown as jest.Mocked<InstagramOAuthClient>;
}
