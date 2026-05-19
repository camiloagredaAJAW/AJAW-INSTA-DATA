import { UnauthorizedException } from '@nestjs/common';
import { ChatwootWebhookController } from '../src/http/routes/chatwoot-webhook.controller';
import { InstagramOutboundMessagesService } from '../src/application/instagramOutboundMessages';

describe('ChatwootWebhookController', () => {
  it('acks irrelevant incoming API inbox webhooks without requiring a signature', async () => {
    const service = outboundServiceMock({ relevant: false });
    const controller = new ChatwootWebhookController(service);

    await expect(
      controller.ingest(undefined, undefined, { rawBody: Buffer.from('{}') } as never, {
        event: 'message_created',
        message_type: 'incoming',
      }),
    ).resolves.toEqual({ status: 'ignored', reason: 'not_outbound_instagram_reply' });

    expect(service.isValidChatwootWebhookSignature).not.toHaveBeenCalled();
    expect(service.handleChatwootMessageCreated).not.toHaveBeenCalled();
  });

  it('accepts relevant outgoing webhooks without signature headers for Chatwoot instances that do not sign API inbox webhooks', async () => {
    const service = outboundServiceMock({ relevant: true, validSignature: false });
    const controller = new ChatwootWebhookController(service);

    await expect(
      controller.ingest(undefined, undefined, { rawBody: Buffer.from('{}') } as never, outgoingPayload()),
    ).resolves.toEqual({ status: 'sent' });

    expect(service.handleChatwootMessageCreated).toHaveBeenCalledWith(outgoingPayload());
  });

  it('rejects relevant outgoing webhooks when signature headers are present but invalid', async () => {
    const service = outboundServiceMock({ relevant: true, validSignature: false });
    const controller = new ChatwootWebhookController(service);

    await expect(
      controller.ingest('sha256=bad', '1710000000', { rawBody: Buffer.from('{}') } as never, outgoingPayload()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function outgoingPayload() {
  return {
    event: 'message_created',
    message_type: 'outgoing',
    content: 'Hola',
    account: { id: 50 },
    inbox: { id: 78 },
    contact: { identifier: 'instagram:user:123' },
  };
}

function outboundServiceMock(options: { relevant: boolean; validSignature?: boolean }) {
  return {
    isRelevantOutboundWebhook: jest.fn().mockReturnValue(options.relevant),
    isValidChatwootWebhookSignature: jest.fn().mockResolvedValue(options.validSignature ?? true),
    handleChatwootMessageCreated: jest.fn().mockResolvedValue({ status: 'sent' }),
  } as unknown as InstagramOutboundMessagesService;
}
