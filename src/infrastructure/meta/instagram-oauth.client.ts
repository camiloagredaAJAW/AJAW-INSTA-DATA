import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentConfig } from '../../config/environment';
import { SafeInstagramOAuthError } from '../../application/ports/instagram-login.port';
import { redactText } from '../../shared/redaction';

export interface InstagramShortLivedTokenRequest {
  code: string;
  redirectUri: string;
}

export interface InstagramShortLivedTokenResponse {
  accessToken: string;
  userId: string;
  permissions?: string[];
}

export interface InstagramLongLivedTokenResponse {
  accessToken: string;
  tokenType?: string;
  expiresIn?: number;
}

export interface InstagramProfileResponse {
  userId: string;
  username?: string;
  name?: string;
}

export interface InstagramMessagingUserProfileResponse {
  username?: string;
  name?: string;
  profilePic?: string;
}

export type InstagramLongLivedTokenResult =
  | { ok: true; token: InstagramLongLivedTokenResponse }
  | { ok: false; error: SafeInstagramOAuthError };

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<HttpResponseLike>;

export const INSTAGRAM_OAUTH_FETCH = Symbol('INSTAGRAM_OAUTH_FETCH');

@Injectable()
export class InstagramOAuthClient {
  private readonly fetcher: FetchLike;

  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    @Optional() @Inject(INSTAGRAM_OAUTH_FETCH) fetcher?: FetchLike,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  async exchangeCodeForShortLivedToken(request: InstagramShortLivedTokenRequest): Promise<InstagramShortLivedTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.getRequiredConfig('META_APP_ID'),
      client_secret: this.getRequiredConfig('META_APP_SECRET'),
      grant_type: 'authorization_code',
      redirect_uri: request.redirectUri,
      code: request.code,
    });

    const response = await this.fetcher('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new Error(`Instagram short-lived token exchange failed: ${await safeErrorMessage(response)}`);
    }

    return parseShortLivedTokenResponse(await response.json());
  }

  async tryExchangeLongLivedToken(shortLivedAccessToken: string): Promise<InstagramLongLivedTokenResult> {
    const url = new URL('https://graph.instagram.com/access_token');
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', this.getRequiredConfig('META_APP_SECRET'));
    url.searchParams.set('access_token', shortLivedAccessToken);

    try {
      const response = await this.fetcher(url.toString(), { method: 'GET' });
      if (!response.ok) {
        return { ok: false, error: await safeError(response) };
      }

      return { ok: true, token: parseLongLivedTokenResponse(await response.json()) };
    } catch (error) {
      return { ok: false, error: { message: redactText(error instanceof Error ? error.message : String(error)) } };
    }
  }

  async fetchProfile(accessToken: string): Promise<InstagramProfileResponse> {
    const url = new URL('https://graph.instagram.com/v25.0/me');
    url.searchParams.set('fields', 'user_id,username,name');
    url.searchParams.set('access_token', accessToken);

    const response = await this.fetcher(url.toString(), { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Instagram profile lookup failed: ${await safeErrorMessage(response)}`);
    }

    return parseProfileResponse(await response.json());
  }

  async fetchMessagingUserProfile(scopedUserId: string, accessToken: string): Promise<InstagramMessagingUserProfileResponse> {
    const url = new URL(`https://graph.instagram.com/v25.0/${encodeURIComponent(scopedUserId)}`);
    url.searchParams.set('fields', 'name,username,profile_pic');
    url.searchParams.set('access_token', accessToken);

    const response = await this.fetcher(url.toString(), { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Instagram messaging user profile lookup failed: ${await safeErrorMessage(response)}`);
    }

    return parseMessagingUserProfileResponse(await response.json());
  }

  private getRequiredConfig(key: 'META_APP_ID' | 'META_APP_SECRET'): string {
    const value = this.configService.get(key, { infer: true });
    if (!value) {
      throw new Error(`${key} is required for Instagram OAuth`);
    }
    return value;
  }
}

async function safeError(response: HttpResponseLike): Promise<SafeInstagramOAuthError> {
  return { status: response.status, message: redactText(await response.text()) };
}

async function safeErrorMessage(response: HttpResponseLike): Promise<string> {
  const error = await safeError(response);
  return `status ${error.status ?? 'unknown'} ${error.message}`;
}

function parseShortLivedTokenResponse(body: unknown): InstagramShortLivedTokenResponse {
  if (!isRecord(body) || typeof body.access_token !== 'string' || typeof body.user_id !== 'number') {
    throw new Error('Instagram short-lived token response was missing required fields');
  }

  return {
    accessToken: body.access_token,
    userId: String(body.user_id),
    permissions: Array.isArray(body.permissions) ? body.permissions.filter((permission): permission is string => typeof permission === 'string') : undefined,
  };
}

function parseLongLivedTokenResponse(body: unknown): InstagramLongLivedTokenResponse {
  if (!isRecord(body) || typeof body.access_token !== 'string') {
    throw new Error('Instagram long-lived token response was missing required fields');
  }

  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === 'string' ? body.token_type : undefined,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : undefined,
  };
}

function parseProfileResponse(body: unknown): InstagramProfileResponse {
  const record = unwrapProfileRecord(body);
  if (!isRecord(record)) {
    throw new Error('Instagram profile response was missing required fields');
  }

  const userId = typeof record.user_id === 'string' ? record.user_id : typeof record.user_id === 'number' ? String(record.user_id) : undefined;
  if (!userId) {
    throw new Error('Instagram profile response was missing required fields');
  }

  return {
    userId,
    username: typeof record.username === 'string' ? record.username : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
  };
}

function parseMessagingUserProfileResponse(body: unknown): InstagramMessagingUserProfileResponse {
  if (!isRecord(body)) {
    return {};
  }

  return {
    username: typeof body.username === 'string' ? body.username : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    profilePic: typeof body.profile_pic === 'string' ? body.profile_pic : undefined,
  };
}

function unwrapProfileRecord(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }

  if (Array.isArray(body.data)) {
    return body.data[0];
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
