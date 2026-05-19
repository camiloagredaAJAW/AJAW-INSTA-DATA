import { ConfigService } from '@nestjs/config';
import { EnvironmentConfig } from '../src/config/environment';
import { FetchLike, InstagramOAuthClient } from '../src/infrastructure/meta/instagram-oauth.client';

describe('InstagramOAuthClient', () => {
  it('exchanges an OAuth code with Instagram using form-urlencoded body', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { access_token: 'short-lived-token', user_id: 178414000000, permissions: ['instagram_business_basic'] },
      }),
    );
    const client = new InstagramOAuthClient(configService(), fetcher);

    await expect(client.exchangeCodeForShortLivedToken({ code: 'oauth-code', redirectUri: 'https://app.test/integrations/instagram/webhook' })).resolves.toEqual({
      accessToken: 'short-lived-token',
      userId: '178414000000',
      permissions: ['instagram_business_basic'],
    });

    expect(fetcher).toHaveBeenCalledWith('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: expect.any(URLSearchParams),
    });

    const body = fetcher.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('client_id')).toBe('meta-app-id');
    expect(body.get('client_secret')).toBe('meta-app-secret');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe('https://app.test/integrations/instagram/webhook');
    expect(body.get('code')).toBe('oauth-code');
  });

  it('uses Graph GET query parameters for best-effort long-lived exchange', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { access_token: 'long-lived-token', token_type: 'bearer', expires_in: 5183944 },
      }),
    );
    const client = new InstagramOAuthClient(configService(), fetcher);

    await expect(client.tryExchangeLongLivedToken('short-lived-token')).resolves.toEqual({
      ok: true,
      token: { accessToken: 'long-lived-token', tokenType: 'bearer', expiresIn: 5183944 },
    });

    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://graph.instagram.com/access_token');
    expect(url.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(url.searchParams.get('client_secret')).toBe('meta-app-secret');
    expect(url.searchParams.get('access_token')).toBe('short-lived-token');
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });

  it('returns sanitized metadata when long-lived exchange fails', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        ok: false,
        status: 400,
        body: 'access_token=short-lived-token secret=meta-app-secret failed',
      }),
    );
    const client = new InstagramOAuthClient(configService(), fetcher);

    await expect(client.tryExchangeLongLivedToken('short-lived-token')).resolves.toEqual({
      ok: false,
      error: { status: 400, message: 'access_token=[REDACTED] secret=[REDACTED] failed' },
    });
  });

  it('fetches the Instagram professional profile used by webhooks', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { user_id: '17841410077817456', username: 'ajaw_ai', name: 'AJAW AI' } }),
    );
    const client = new InstagramOAuthClient(configService(), fetcher);

    await expect(client.fetchProfile('long-lived-token')).resolves.toEqual({
      userId: '17841410077817456',
      username: 'ajaw_ai',
      name: 'AJAW AI',
    });

    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://graph.instagram.com/v25.0/me');
    expect(url.searchParams.get('fields')).toBe('user_id,username,name');
    expect(url.searchParams.get('access_token')).toBe('long-lived-token');
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });

  it('accepts Instagram profile responses wrapped in a data array', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { data: [{ user_id: '17841410077817456', username: 'ajaw_ai' }] } }),
    );
    const client = new InstagramOAuthClient(configService(), fetcher);

    await expect(client.fetchProfile('token')).resolves.toEqual({ userId: '17841410077817456', username: 'ajaw_ai', name: undefined });
  });

  it('fetches Instagram messaging sender profile details from the scoped sender id', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: { name: 'Peter Chang', username: 'peter_chang_live', profile_pic: 'https://profile.test/peter.jpg' } }),
    );
    const client = new InstagramOAuthClient(configService(), fetcher);

    await expect(client.fetchMessagingUserProfile('1634976877768677', 'instagram-token')).resolves.toEqual({
      name: 'Peter Chang',
      username: 'peter_chang_live',
      profilePic: 'https://profile.test/peter.jpg',
    });

    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://graph.instagram.com/v25.0/1634976877768677');
    expect(url.searchParams.get('fields')).toBe('name,username,profile_pic');
    expect(url.searchParams.get('access_token')).toBe('instagram-token');
  });
});

function configService(): ConfigService<EnvironmentConfig, true> {
  const values: Partial<EnvironmentConfig> = {
    META_APP_ID: 'meta-app-id',
    META_APP_SECRET: 'meta-app-secret',
  };

  return {
    get: (key: keyof EnvironmentConfig) => values[key],
  } as unknown as ConfigService<EnvironmentConfig, true>;
}

function response({ ok = true, status = 200, body = {} }: ResponseOptions) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface ResponseOptions {
  ok?: boolean;
  status?: number;
  body?: unknown;
}
