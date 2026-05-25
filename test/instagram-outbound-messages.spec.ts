import { InstagramOutboundMessagesService } from '../src/application/instagramOutboundMessages';
import { createHmac } from 'node:crypto';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../src/infrastructure/chatwoot/chatwoot.client';
import { InstagramOAuthClient } from '../src/infrastructure/meta/instagram-oauth.client';

describe('InstagramOutboundMessagesService', () => {
  it('sends Chatwoot outgoing API inbox replies to the Instagram contact', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' });
    const instagramOAuthClient = oauthMock({ messageId: 'ig-mid-1' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootMock(), instagramOAuthClient);

    await expect(service.handleChatwootMessageCreated(chatwootOutgoingPayload())).resolves.toEqual({ status: 'sent', messageId: 'ig-mid-1' });

    expect(axelorClient.findInstagramAccountByChatwootLinkage).toHaveBeenCalledWith(50, 78);
    expect(instagramOAuthClient.sendTextMessage).toHaveBeenCalledWith('17841410077817456', '1634976877768677', 'Hola desde Chatwoot', 'instagram-token');
    expect(service.wasSentByThisService('ig-mid-1')).toBe(true);
    expect(service.wasRecentlySentByThisService('1634976877768677', 'Hola desde Chatwoot')).toBe(true);
  });

  it('resolves outgoing reply recipients from Chatwoot conversation metadata', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' });
    const instagramOAuthClient = oauthMock({ messageId: 'ig-mid-1' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootMock(), instagramOAuthClient);
    const payload = {
      ...chatwootOutgoingPayload(),
      contact: undefined,
      conversation: { meta: { sender: { identifier: 'instagram:user:1634976877768677' } } },
    };

    expect(service.isRelevantOutboundWebhook(payload)).toBe(true);

    await expect(service.handleChatwootMessageCreated(payload)).resolves.toEqual({ status: 'sent', messageId: 'ig-mid-1' });

    expect(instagramOAuthClient.sendTextMessage).toHaveBeenCalledWith('17841410077817456', '1634976877768677', 'Hola desde Chatwoot', 'instagram-token');
  });

  it('resolves outgoing reply recipients from Chatwoot contact inbox source id', async () => {
    const service = new InstagramOutboundMessagesService(axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token' }), chatwootMock(), oauthMock());
    const payload = {
      ...chatwootOutgoingPayload(),
      contact: undefined,
      conversation: { contact_inbox: { source_id: 'ig:17841410077817456:user:1634976877768677' } },
    };

    expect(service.isRelevantOutboundWebhook(payload)).toBe(true);
  });

  it('expands Chatwoot reply-to metadata into plain text before sending to Instagram', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock(undefined, [
      { id: 99, content: 'Instagram comment on https://www.instagram.com/p/DYkG5cnDjBp/\n\nExcelente me gusta ❤️' },
    ]);
    const instagramOAuthClient = oauthMock({ messageId: 'ig-mid-1' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootClient, instagramOAuthClient);
    const payload = {
      ...chatwootOutgoingPayload(),
      content: 'que bueno que te guste estamos trabajando fuerte para ponerlo a producción lo antes posible',
      conversation: { id: 30, contact_inbox: { source_id: 'ig:17841410077817456:user:1634976877768677' } },
      content_attributes: { in_reply_to: 99 },
    };

    await expect(service.handleChatwootMessageCreated(payload)).resolves.toEqual({ status: 'sent', messageId: 'ig-mid-1' });

    expect(chatwootClient.listConversationMessages).toHaveBeenCalledWith(50, 'agent-secret', 30);
    expect(instagramOAuthClient.sendTextMessage).toHaveBeenCalledWith(
      '17841410077817456',
      '1634976877768677',
      'En respuesta a:\n> Instagram comment on https://www.instagram.com/p/DYkG5cnDjBp/\n> \n> Excelente me gusta ❤️\n\nque bueno que te guste estamos trabajando fuerte para ponerlo a producción lo antes posible',
      'instagram-token',
    );
  });

  it('falls back to conversation custom attributes for Chatwoot comment replies when original message is not listed', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', agent: { id: 7 } }, { id: 7, chatwootApiKey: 'agent-secret' });
    const chatwootClient = chatwootMock(
      undefined,
      [],
      {
        id: 21,
        custom_attributes: {
          instagram_publication_url: 'https://www.instagram.com/p/DYkG5cnDjBp/',
          instagram_source_event_id: '18317971390259755',
        },
        messages: [{ id: 9925, content: 'perdón, es contestando a este mensaje, que pena' }],
      },
    );
    const instagramOAuthClient = oauthMock({ messageId: 'ig-mid-1' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootClient, instagramOAuthClient);
    const payload = {
      ...chatwootOutgoingPayload(),
      content: 'perdón, es contestando a este mensaje, que pena',
      conversation: { id: 21, contact_inbox: { source_id: 'ig:comment:18317971390259755' } },
      content_attributes: { in_reply_to: 9922, in_reply_to_external_id: 'ig:event:18317971390259755' },
    };

    await expect(service.handleChatwootMessageCreated(payload)).resolves.toEqual({ status: 'sent', messageId: 'ig-mid-1' });

    expect(axelorClient.fetchAgent).toHaveBeenCalledWith(7);
    expect(chatwootClient.listConversationMessages).toHaveBeenCalledWith(50, 'agent-secret', 21);
    expect(chatwootClient.getConversation).toHaveBeenCalledWith(50, 'agent-secret', 21);
    expect(instagramOAuthClient.sendTextMessage).toHaveBeenCalledWith(
      '17841410077817456',
      '1634976877768677',
      'En respuesta a:\n> Instagram comment on https://www.instagram.com/p/DYkG5cnDjBp/\n\nperdón, es contestando a este mensaje, que pena',
      'instagram-token',
    );
  });

  it('uses inline quoted content when Chatwoot includes it in webhook content_attributes', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock();
    const instagramOAuthClient = oauthMock({ messageId: 'ig-mid-1' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootClient, instagramOAuthClient);
    const payload = {
      ...chatwootOutgoingPayload(),
      content: 'sisisis',
      content_attributes: { in_reply_to: { id: 99, content: 'Instagram comment on https://www.instagram.com/p/DYkG5cnDjBp/ Excelente me gusta ❤️' } },
    };

    await expect(service.handleChatwootMessageCreated(payload)).resolves.toEqual({ status: 'sent', messageId: 'ig-mid-1' });

    expect(chatwootClient.listConversationMessages).not.toHaveBeenCalled();
    expect(instagramOAuthClient.sendTextMessage).toHaveBeenCalledWith(
      '17841410077817456',
      '1634976877768677',
      'En respuesta a:\n> Instagram comment on https://www.instagram.com/p/DYkG5cnDjBp/ Excelente me gusta ❤️\n\nsisisis',
      'instagram-token',
    );
  });

  it('validates Chatwoot API inbox webhook signatures with the stored channel secret', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootMock(), oauthMock());
    const rawBody = Buffer.from(JSON.stringify(chatwootOutgoingPayload()));
    const timestamp = '1710000000';
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(`${timestamp}.`).update(rawBody).digest('hex')}`;

    await expect(service.isValidChatwootWebhookSignature(chatwootOutgoingPayload(), { signature, timestamp, rawBody })).resolves.toBe(true);

    expect(axelorClient.findInstagramAccountByChatwootLinkage).toHaveBeenCalledWith(50, 78);
  });

  it('rejects Chatwoot webhook signatures that do not match the stored channel secret', async () => {
    const service = new InstagramOutboundMessagesService(axelorMock({ chatwootHmacToken: 'webhook-secret' }), chatwootMock(), oauthMock());
    const rawBody = Buffer.from(JSON.stringify(chatwootOutgoingPayload()));
    const timestamp = '1710000000';
    const signature = `sha256=${createHmac('sha256', 'wrong-secret').update(`${timestamp}.`).update(rawBody).digest('hex')}`;

    await expect(service.isValidChatwootWebhookSignature(chatwootOutgoingPayload(), { signature, timestamp, rawBody })).resolves.toBe(false);
  });

  it('refreshes the Chatwoot channel secret when the stored token is stale', async () => {
    const axelorClient = axelorMock({ id: 11, version: 3, chatwootAccountId: 50, chatwootHmacToken: 'stale-hmac-token', agent: { id: 7, chatwootApiKey: 'agent-secret' } });
    const chatwootClient = chatwootMock({ id: 78, secret: 'webhook-secret' });
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootClient, oauthMock());
    const rawBody = Buffer.from(JSON.stringify(chatwootOutgoingPayload()));
    const timestamp = '1710000000';
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(`${timestamp}.`).update(rawBody).digest('hex')}`;

    await expect(service.isValidChatwootWebhookSignature(chatwootOutgoingPayload(), { signature, timestamp, rawBody })).resolves.toBe(true);

    expect(chatwootClient.listInboxes).toHaveBeenCalledWith(50, 'agent-secret');
    expect(axelorClient.updateInstagramAccount).toHaveBeenCalledWith(11, 3, { chatwootHmacToken: 'webhook-secret' });
  });

  it('ignores non-outgoing or non-Instagram Chatwoot messages', async () => {
    const service = new InstagramOutboundMessagesService(axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' }), chatwootMock(), oauthMock());

    expect(service.isRelevantOutboundWebhook({ ...chatwootOutgoingPayload(), message_type: 'incoming' })).toBe(false);
    expect(service.isRelevantOutboundWebhook(chatwootOutgoingPayload())).toBe(true);

    await expect(service.handleChatwootMessageCreated({ ...chatwootOutgoingPayload(), message_type: 'incoming' })).resolves.toEqual({
      status: 'ignored',
      reason: 'not_outbound_instagram_reply',
    });
    await expect(service.handleChatwootMessageCreated({ ...chatwootOutgoingPayload(), contact: { identifier: 'email:user@example.com' } })).resolves.toEqual({
      status: 'ignored',
      reason: 'not_outbound_instagram_reply',
    });
  });

  it('classifies Instagram messaging window policy failures', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' });
    const instagramOAuthClient = oauthMock();
    instagramOAuthClient.sendTextMessage.mockRejectedValueOnce(
      new Error('Instagram send message failed: status 403 {"error":{"message":"This message is sent outside of allowed window.","type":"IGApiException","code":10,"error_subcode":2534022}}'),
    );
    const service = new InstagramOutboundMessagesService(axelorClient, chatwootMock(), instagramOAuthClient);

    await expect(service.handleChatwootMessageCreated(chatwootOutgoingPayload())).resolves.toEqual({
      status: 'failed',
      reason: 'instagram_messaging_window_closed',
    });
  });
});

function chatwootOutgoingPayload() {
  return {
    event: 'message_created',
    id: 123,
    content: 'Hola desde Chatwoot',
    message_type: 'outgoing',
    private: false,
    account: { id: 50 },
    inbox: { id: 78 },
    contact: { identifier: 'instagram:user:1634976877768677' },
  };
}

function axelorMock(
  account: { id?: string | number; version?: number; instagramUserId?: string; accessToken?: string; chatwootAccountId?: string | number; chatwootHmacToken?: string; agent?: { id: string | number; chatwootApiKey?: string } } | null,
  agent: { id: string | number; chatwootApiKey?: string } | null = null,
) {
  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    findInstagramAccountByChatwootLinkage: jest.fn().mockResolvedValue(account),
    fetchAgent: jest.fn().mockResolvedValue(agent),
    updateInstagramAccount: jest.fn().mockResolvedValue(account),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function chatwootMock(inbox: { id?: number; secret?: string } = {}, messages: Array<{ id: number; content?: string }> = [], conversation: Record<string, unknown> = { id: 30, messages }) {
  return {
    listInboxes: jest.fn().mockResolvedValue([{ id: inbox.id ?? 78, secret: inbox.secret }]),
    listConversationMessages: jest.fn().mockResolvedValue(messages),
    getConversation: jest.fn().mockResolvedValue(conversation),
  } as unknown as jest.Mocked<DefaultChatwootClient>;
}

function oauthMock(result: { messageId?: string } = {}) {
  return {
    sendTextMessage: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<InstagramOAuthClient>;
}
