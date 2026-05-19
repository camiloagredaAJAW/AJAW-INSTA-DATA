import { Body, Controller, Headers, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ChatwootMessageCreatedPayload, InstagramOutboundMessagesService, OutboundMessageResult } from '../../application/instagramOutboundMessages';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('integrations/chatwoot/webhook')
export class ChatwootWebhookController {
  private readonly logger = new Logger(ChatwootWebhookController.name);

  constructor(
    private readonly outboundMessages: InstagramOutboundMessagesService,
  ) {}

  @Post()
  @HttpCode(200)
  async ingest(
    @Headers('x-chatwoot-signature') signature: string | undefined,
    @Headers('x-chatwoot-timestamp') timestamp: string | undefined,
    @Req() request: RawBodyRequest,
    @Body() body: ChatwootMessageCreatedPayload,
  ): Promise<OutboundMessageResult> {
    if (!this.outboundMessages.isRelevantOutboundWebhook(body)) {
      return { status: 'ignored', reason: 'not_outbound_instagram_reply' };
    }

    if (!request.rawBody) {
      this.logger.warn('Rejected Chatwoot webhook POST: missing raw body');
      throw new UnauthorizedException('Invalid Chatwoot webhook signature');
    }

    const hasSignatureHeaders = Boolean(signature || timestamp);
    const hasValidSignature = await this.outboundMessages.isValidChatwootWebhookSignature(body, { signature, timestamp, rawBody: request.rawBody });
    if (hasSignatureHeaders && !hasValidSignature) {
      this.logger.warn('Rejected Chatwoot webhook POST: invalid signature');
      throw new UnauthorizedException('Invalid Chatwoot webhook signature');
    }

    if (!hasSignatureHeaders) {
      this.logger.warn('Accepted unsigned Chatwoot outbound webhook because this Chatwoot instance did not send signature headers');
    }

    return this.outboundMessages.handleChatwootMessageCreated(body);
  }
}
