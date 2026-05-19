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

  it('rejects relevant outgoing webhooks when signature validation fails', async () => {
    const service = outboundServiceMock({ relevant: true, validSignature: false });
    const controller = new ChatwootWebhookController(service);

    await expect(
      controller.ingest(undefined, undefined, { rawBody: Buffer.from('{}') } as never, {
        event: 'message_created',
        message_type: 'outgoing',
        content: 'Hola',
        account: { id: 50 },
        inbox: { id: 78 },
        contact: { identifier: 'instagram:user:123' },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function outboundServiceMock(options: { relevant: boolean; validSignature?: boolean }) {
  return {
    isRelevantOutboundWebhook: jest.fn().mockReturnValue(options.relevant),
    isValidChatwootWebhookSignature: jest.fn().mockResolvedValue(options.validSignature ?? true),
    handleChatwootMessageCreated: jest.fn().mockResolvedValue({ status: 'sent' }),
  } as unknown as InstagramOutboundMessagesService;
}
