import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { EnvironmentConfig } from '../config/environment';
import {
  AxelorInstagramAccountRecord,
  buildInstagramAccountConnectedUpdate,
  DefaultAxelorClient,
} from '../infrastructure/axelor/axelor.client';
import { InstagramOAuthClient, InstagramLongLivedTokenResult } from '../infrastructure/meta/instagram-oauth.client';
import {
  InstagramBusinessLoginUseCase,
  InstagramCallbackRequest,
  InstagramCallbackResult,
  InstagramLoginStartRequest,
  InstagramLoginStartResult,
  InstagramLongLivedTokenExchangeMetadata,
} from './ports/instagram-login.port';
import { normalizeAgentId } from './activateInstagramIntegration';

const INSTAGRAM_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const INSTAGRAM_BUSINESS_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];

export class InstagramBusinessLoginError extends Error {
  constructor(
    message: string,
    readonly status: 'bad_request' | 'unauthorized' = 'bad_request',
  ) {
    super(message);
  }
}

@Injectable()
export class InstagramBusinessLoginService implements InstagramBusinessLoginUseCase {
  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    private readonly axelorClient: DefaultAxelorClient,
    private readonly instagramOAuthClient: InstagramOAuthClient,
  ) {}

  async start(request: InstagramLoginStartRequest): Promise<InstagramLoginStartResult> {
    const agentId = normalizeAgentId(request.agentId);
    const state = randomUUID();

    await this.axelorClient.login();

    const agent = await this.axelorClient.fetchAgent(agentId);
    if (!agent) {
      throw new InstagramBusinessLoginError('agentId does not reference a linkable Agent');
    }

    const existingAccount = (await this.axelorClient.searchInstagramAccountsByAgent(agentId, { limit: 1 }))[0];
    const instagramAccount = existingAccount ? await this.persistState(existingAccount, state) : await this.axelorClient.createInstagramAccount(agentId, state);

    return {
      authorizeUrl: this.buildAuthorizeUrl(state),
      state,
      instagramAccountId: instagramAccount.id,
    };
  }

  async completeCallback(request: InstagramCallbackRequest): Promise<InstagramCallbackResult> {
    const code = requireNonEmpty(request.code, 'code');
    const state = requireNonEmpty(request.state, 'state');

    await this.axelorClient.login();

    const instagramAccount = await this.axelorClient.findInstagramAccountByState(state, { limit: 1 });
    if (!instagramAccount) {
      throw new InstagramBusinessLoginError('Invalid or replayed Instagram OAuth state', 'unauthorized');
    }

    if (typeof instagramAccount.version !== 'number') {
      throw new InstagramBusinessLoginError('InstagramAccount version is required to complete OAuth callback');
    }

    const redirectUri = this.getRedirectUri();
    const shortLivedToken = await this.instagramOAuthClient.exchangeCodeForShortLivedToken({ code, redirectUri });
    const longLivedTokenExchange = await this.tryLongLivedExchange(shortLivedToken.accessToken);
    const connectedAt = new Date().toISOString();
    const longLivedToken = longLivedTokenExchange.result?.ok ? longLivedTokenExchange.result.token : null;
    const accessToken = longLivedToken?.accessToken ?? shortLivedToken.accessToken;
    const tokenExpiresAt = longLivedToken?.expiresIn ? new Date(Date.now() + longLivedToken.expiresIn * 1000).toISOString() : undefined;

    await this.axelorClient.updateInstagramAccount(
      instagramAccount.id,
      instagramAccount.version,
      buildInstagramAccountConnectedUpdate({
        instagramUserId: shortLivedToken.userId,
        accessToken,
        connectedAt,
        tokenExpiresAt,
      }),
    );

    return {
      status: 'connected',
      instagramAccountId: instagramAccount.id,
      instagramUserId: shortLivedToken.userId,
      tokenSource: longLivedToken ? 'long_lived' : 'short_lived',
      longLivedTokenExchange: longLivedTokenExchange.metadata,
    };
  }

  private async persistState(instagramAccount: AxelorInstagramAccountRecord, state: string): Promise<AxelorInstagramAccountRecord> {
    if (typeof instagramAccount.version !== 'number') {
      throw new InstagramBusinessLoginError('InstagramAccount version is required to start OAuth login');
    }

    return this.axelorClient.updateInstagramAccountOAuthState(instagramAccount.id, instagramAccount.version, state);
  }

  private buildAuthorizeUrl(state: string): string {
    const clientId = this.configService.get('META_APP_ID', { infer: true });
    if (!clientId) {
      throw new InstagramBusinessLoginError('META_APP_ID is required to start Instagram OAuth login');
    }

    const url = new URL(INSTAGRAM_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.getRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', INSTAGRAM_BUSINESS_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  private getRedirectUri(): string {
    const redirectUri = this.configService.get('INSTAGRAM_OAUTH_REDIRECT_URI', { infer: true });
    if (!redirectUri) {
      throw new InstagramBusinessLoginError('INSTAGRAM_OAUTH_REDIRECT_URI or APP_BASE_URL is required for Instagram OAuth');
    }

    return redirectUri;
  }

  private async tryLongLivedExchange(shortLivedAccessToken: string): Promise<{
    metadata: InstagramLongLivedTokenExchangeMetadata;
    result?: InstagramLongLivedTokenResult;
  }> {
    if (!this.configService.get('INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE', { infer: true })) {
      return { metadata: { attempted: false, succeeded: false } };
    }

    const result = await this.instagramOAuthClient.tryExchangeLongLivedToken(shortLivedAccessToken);
    return {
      result,
      metadata: result.ok ? { attempted: true, succeeded: true } : { attempted: true, succeeded: false, error: result.error },
    };
  }
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InstagramBusinessLoginError(`${fieldName} is required`);
  }

  return value.trim();
}
