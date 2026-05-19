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

function axelorMock(account: { id?: string | number; version?: number; instagramUserId?: string; accessToken?: string; chatwootAccountId?: string | number; chatwootHmacToken?: string; agent?: { id: string | number; chatwootApiKey?: string } } | null) {
  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    findInstagramAccountByChatwootLinkage: jest.fn().mockResolvedValue(account),
    updateInstagramAccount: jest.fn().mockResolvedValue(account),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function chatwootMock(inbox: { id?: number; secret?: string } = {}) {
  return {
    listInboxes: jest.fn().mockResolvedValue([{ id: inbox.id ?? 78, secret: inbox.secret }]),
  } as unknown as jest.Mocked<DefaultChatwootClient>;
}

function oauthMock(result: { messageId?: string } = {}) {
  return {
    sendTextMessage: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<InstagramOAuthClient>;
}
