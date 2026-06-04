import { BadRequestException, Controller, Get, Headers, HttpCode, Logger, Query, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request, Response } from 'express';
import { InstagramBusinessLoginError, InstagramBusinessLoginService } from '../../application/instagramBusinessLogin';
import { InstagramWebhookRoutingService } from '../../application/instagramWebhookRouting';
import { InstagramWebhookRouteResult } from '../../application/ports/instagram-webhook.port';
import { EnvironmentConfig } from '../../config/environment';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('integrations/instagram/webhook')
export class InstagramWebhookController {
  private readonly logger = new Logger(InstagramWebhookController.name);

  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    private readonly instagramBusinessLogin: InstagramBusinessLoginService,
    private readonly routingService: InstagramWebhookRoutingService,
  ) {}

  @Get()
  async handleGet(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (challenge !== undefined) {
      this.logger.log('Instagram webhook verification GET received');
      response.status(200).send(this.verify(mode, verifyToken, challenge));
      return;
    }

    if (code !== undefined && state !== undefined) {
      try {
        this.logger.log(`Instagram OAuth callback received: state=${state}`);
        const result = await this.instagramBusinessLogin.completeCallback({ code, state });
        this.logger.log(
          `Instagram OAuth callback completed: instagramAccountId=${result.instagramAccountId} instagramUserId=${result.instagramUserId} tokenSource=${result.tokenSource}`,
        );
        response.redirect(this.buildConnectedRedirectUrl(result.status, result.username, result.name));
        return;
      } catch (error) {
        if (error instanceof InstagramBusinessLoginError) {
          if (error.status === 'unauthorized') {
            throw new UnauthorizedException(error.message);
          }

          throw new BadRequestException(error.message);
        }

        throw error;
      }
    }

    throw new BadRequestException('Invalid Instagram webhook GET request');
  }

  private buildConnectedRedirectUrl(status: 'connected' | 'unconnected', username?: string, name?: string): string {
    const baseUrl = this.getConnectedRedirectBaseUrl();
    const url = new URL('/instagram/connected', baseUrl);
    url.searchParams.set('status', status);
    url.searchParams.set('username', username ?? '');
    url.searchParams.set('name', name ?? '');
    return url.toString();
  }

  private getConnectedRedirectBaseUrl(): string {
    const configured = this.configService.get('INSTAGRAM_CONNECTED_REDIRECT_BASE_URL', { infer: true });
    if (configured) {
      return configured;
    }

    const axelorBaseUrl = this.configService.get('AXELOR_BASE_URL', { infer: true });
    const parsed = new URL(axelorBaseUrl);
    if (parsed.hostname === 'data.ajawmrp.com') {
      return 'https://data.ajaw.ai';
    }

    return axelorBaseUrl;
  }

  private verify(mode: string | undefined, verifyToken: string | undefined, challenge: string | undefined): string {
    const expectedToken = this.configService.get('META_WEBHOOK_VERIFY_TOKEN', { infer: true });

    if (!expectedToken || mode !== 'subscribe' || !verifyToken || verifyToken !== expectedToken || challenge === undefined) {
      throw new UnauthorizedException('Invalid webhook verification request');
    }

    return challenge;
  }

  @Post()
  @HttpCode(200)
  async ingest(@Headers('x-hub-signature-256') signature: string | undefined, @Req() request: RawBodyRequest): Promise<InstagramWebhookRouteResult> {
    const rawBody = request.rawBody;

    if (!rawBody || !this.isValidSignature(signature, rawBody)) {
      this.logger.warn('Rejected Instagram webhook POST: invalid or missing Meta signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.log('Accepted signed Instagram webhook POST');
    return this.routingService.route({ payload: request.body });
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
