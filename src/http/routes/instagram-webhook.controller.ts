import { Controller, Get, Headers, HttpCode, Query, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { EnvironmentConfig } from '../../config/environment';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('integrations/instagram/webhook')
export class InstagramWebhookController {
  constructor(private readonly configService: ConfigService<EnvironmentConfig, true>) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    const expectedToken = this.configService.get('META_WEBHOOK_VERIFY_TOKEN', { infer: true });

    if (!expectedToken || mode !== 'subscribe' || !verifyToken || verifyToken !== expectedToken || challenge === undefined) {
      throw new UnauthorizedException('Invalid webhook verification request');
    }

    return challenge;
  }

  @Post()
  @HttpCode(200)
  ingest(@Headers('x-hub-signature-256') signature: string | undefined, @Req() request: RawBodyRequest): { status: 'ok' } {
    const rawBody = request.rawBody;

    if (!rawBody || !this.isValidSignature(signature, rawBody)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return { status: 'ok' };
  }

  private isValidSignature(signature: string | undefined, rawBody: Buffer): boolean {
    if (!signature?.startsWith('sha256=')) {
      return false;
    }

    const providedHex = signature.slice('sha256='.length);
    if (!/^[a-fA-F0-9]{64}$/.test(providedHex)) {
      return false;
    }

    const appSecret = this.configService.get('META_APP_SECRET', { infer: true });
    if (!appSecret) {
      return false;
    }

    const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(providedHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');

    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}
