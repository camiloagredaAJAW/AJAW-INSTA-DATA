import { InstagramOutboundMessagesService } from '../src/application/instagramOutboundMessages';
import { createHmac } from 'node:crypto';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { InstagramOAuthClient } from '../src/infrastructure/meta/instagram-oauth.client';

describe('InstagramOutboundMessagesService', () => {
  it('sends Chatwoot outgoing API inbox replies to the Instagram contact', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' });
    const instagramOAuthClient = oauthMock({ messageId: 'ig-mid-1' });
    const service = new InstagramOutboundMessagesService(axelorClient, instagramOAuthClient);

    await expect(service.handleChatwootMessageCreated(chatwootOutgoingPayload())).resolves.toEqual({ status: 'sent', messageId: 'ig-mid-1' });

    expect(axelorClient.findInstagramAccountByChatwootLinkage).toHaveBeenCalledWith(50, 78);
    expect(instagramOAuthClient.sendTextMessage).toHaveBeenCalledWith('17841410077817456', '1634976877768677', 'Hola desde Chatwoot', 'instagram-token');
    expect(service.wasSentByThisService('ig-mid-1')).toBe(true);
  });

  it('validates Chatwoot API inbox webhook signatures with the stored channel secret', async () => {
    const axelorClient = axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' });
    const service = new InstagramOutboundMessagesService(axelorClient, oauthMock());
    const rawBody = Buffer.from(JSON.stringify(chatwootOutgoingPayload()));
    const timestamp = '1710000000';
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(`${timestamp}.`).update(rawBody).digest('hex')}`;

    await expect(service.isValidChatwootWebhookSignature(chatwootOutgoingPayload(), { signature, timestamp, rawBody })).resolves.toBe(true);

    expect(axelorClient.findInstagramAccountByChatwootLinkage).toHaveBeenCalledWith(50, 78);
  });

  it('rejects Chatwoot webhook signatures that do not match the stored channel secret', async () => {
    const service = new InstagramOutboundMessagesService(axelorMock({ chatwootHmacToken: 'webhook-secret' }), oauthMock());
    const rawBody = Buffer.from(JSON.stringify(chatwootOutgoingPayload()));
    const timestamp = '1710000000';
    const signature = `sha256=${createHmac('sha256', 'wrong-secret').update(`${timestamp}.`).update(rawBody).digest('hex')}`;

    await expect(service.isValidChatwootWebhookSignature(chatwootOutgoingPayload(), { signature, timestamp, rawBody })).resolves.toBe(false);
  });

  it('ignores non-outgoing or non-Instagram Chatwoot messages', async () => {
    const service = new InstagramOutboundMessagesService(axelorMock({ instagramUserId: '17841410077817456', accessToken: 'instagram-token', chatwootHmacToken: 'webhook-secret' }), oauthMock());

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

function axelorMock(account: { instagramUserId?: string; accessToken?: string; chatwootHmacToken?: string } | null) {
  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    findInstagramAccountByChatwootLinkage: jest.fn().mockResolvedValue(account),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function oauthMock(result: { messageId?: string } = {}) {
  return {
    sendTextMessage: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<InstagramOAuthClient>;
}
