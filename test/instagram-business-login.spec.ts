import { ConfigService } from '@nestjs/config';
import { InstagramBusinessLoginError, InstagramBusinessLoginService } from '../src/application/instagramBusinessLogin';
import { EnvironmentConfig } from '../src/config/environment';
import { DefaultAxelorClient } from '../src/infrastructure/axelor/axelor.client';
import { InstagramOAuthClient } from '../src/infrastructure/meta/instagram-oauth.client';

describe('InstagramBusinessLoginService', () => {
  it('logs into Axelor, stores fresh state on an existing account, and builds the Meta authorize URL', async () => {
    const axelor = axelorMock({
      agent: { id: 7 },
      instagramAccounts: [{ id: 11, version: 3 }],
    });
    const service = new InstagramBusinessLoginService(configService(), axelor, oauthMock());

    const result = await service.start({ agentId: '7' });
    const authorizeUrl = new URL(result.authorizeUrl);

    expect(result).toMatchObject({ instagramAccountId: 11 });
    expect(result.state).toMatch(/[0-9a-f-]{36}/);
    expect(axelor.login).toHaveBeenCalledTimes(1);
    expect(axelor.fetchAgent).toHaveBeenCalledWith('7');
    expect(axelor.updateInstagramAccountOAuthState).toHaveBeenCalledWith(11, 3, result.state);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('test-meta-app-id');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://app.test/integrations/instagram/webhook');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('state')).toBe(result.state);
    expect(authorizeUrl.searchParams.get('scope')).toBe('instagram_business_basic instagram_business_manage_messages instagram_business_manage_comments');
  });

  it('creates an OAuth placeholder account when the Agent exists but has no InstagramAccount yet', async () => {
    const axelor = axelorMock({ agent: { id: 7 }, instagramAccounts: [] });
    const service = new InstagramBusinessLoginService(configService(), axelor, oauthMock());

    const result = await service.start({ agentId: 7 });

    expect(axelor.createInstagramAccount).toHaveBeenCalledWith(7, result.state);
    expect(result.instagramAccountId).toBe(99);
  });

  it('rejects login start when the Agent context is missing and does not persist state', async () => {
    const axelor = axelorMock({ agent: null });
    const service = new InstagramBusinessLoginService(configService(), axelor, oauthMock());

    await expect(service.start({ agentId: 7 })).rejects.toThrow(InstagramBusinessLoginError);
    expect(axelor.searchInstagramAccountsByAgent).not.toHaveBeenCalled();
    expect(axelor.updateInstagramAccountOAuthState).not.toHaveBeenCalled();
    expect(axelor.createInstagramAccount).not.toHaveBeenCalled();
  });

  it('completes a valid callback, clears state, and persists connected account fields', async () => {
    const axelor = axelorMock({ stateAccount: { id: 11, version: 4, instagramState: 'state-123' } });
    const oauth = oauthMock({ shortLived: { accessToken: 'short-token-secret', userId: '17841400000000000' } });
    const service = new InstagramBusinessLoginService(configService(), axelor, oauth);

    await expect(service.completeCallback({ code: 'code-123', state: 'state-123' })).resolves.toEqual({
      status: 'connected',
      instagramAccountId: 11,
      instagramUserId: '17841400000000000',
      tokenSource: 'short_lived',
      longLivedTokenExchange: { attempted: false, succeeded: false },
    });

    expect(oauth.exchangeCodeForShortLivedToken).toHaveBeenCalledWith({ code: 'code-123', redirectUri: 'https://app.test/integrations/instagram/webhook' });
    expect(axelor.updateInstagramAccount).toHaveBeenCalledWith(
      11,
      4,
      expect.objectContaining({
        instagramState: null,
        instagramUserId: '17841400000000000',
        accessToken: 'short-token-secret',
        active: true,
        connectedAt: expect.any(String),
      }),
    );
  });

  it('keeps short-lived callback success when long-lived exchange fails and returns only safe metadata', async () => {
    const axelor = axelorMock({ stateAccount: { id: 11, version: 4, instagramState: 'state-123' } });
    const oauth = oauthMock({
      longLived: { ok: false, error: { status: 400, message: 'redacted oauth failure' } },
    });
    const service = new InstagramBusinessLoginService(configService({ INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE: true }), axelor, oauth);

    await expect(service.completeCallback({ code: 'code-123', state: 'state-123' })).resolves.toMatchObject({
      status: 'connected',
      tokenSource: 'short_lived',
      longLivedTokenExchange: { attempted: true, succeeded: false, error: { status: 400, message: 'redacted oauth failure' } },
    });

    expect(axelor.updateInstagramAccount).toHaveBeenCalledWith(11, 4, expect.objectContaining({ accessToken: 'short-token-secret' }));
  });

  it('rejects invalid or replayed state before token exchange or account update', async () => {
    const axelor = axelorMock({ stateAccount: null });
    const oauth = oauthMock();
    const service = new InstagramBusinessLoginService(configService(), axelor, oauth);

    await expect(service.completeCallback({ code: 'code-123', state: 'replayed-state' })).rejects.toMatchObject({ status: 'unauthorized' });
    expect(oauth.exchangeCodeForShortLivedToken).not.toHaveBeenCalled();
    expect(axelor.updateInstagramAccount).not.toHaveBeenCalled();
  });
});

function axelorMock(options: AxelorMockOptions = {}) {
  return {
    login: jest.fn().mockResolvedValue({ jsessionId: 'session-id' }),
    fetchAgent: jest.fn().mockResolvedValue(Object.prototype.hasOwnProperty.call(options, 'agent') ? options.agent : { id: 7 }),
    searchInstagramAccountsByAgent: jest.fn().mockResolvedValue(options.instagramAccounts ?? []),
    updateInstagramAccountOAuthState: jest.fn().mockImplementation((id: string | number, version: number, instagramState: string) => Promise.resolve({ id, version: version + 1, instagramState })),
    createInstagramAccount: jest.fn().mockImplementation((_agentId: string | number, instagramState: string) => Promise.resolve({ id: 99, version: 1, instagramState, active: false })),
    findInstagramAccountByState: jest.fn().mockResolvedValue(Object.prototype.hasOwnProperty.call(options, 'stateAccount') ? options.stateAccount : { id: 11, version: 4, instagramState: 'state-123' }),
    updateInstagramAccount: jest.fn().mockImplementation((id: string | number, version: number, data: Record<string, unknown>) => Promise.resolve({ id, version: version + 1, ...data })),
  } as unknown as jest.Mocked<DefaultAxelorClient>;
}

function oauthMock(options: OAuthMockOptions = {}) {
  return {
    exchangeCodeForShortLivedToken: jest.fn().mockResolvedValue(options.shortLived ?? { accessToken: 'short-token-secret', userId: '17841400000000000' }),
    tryExchangeLongLivedToken: jest.fn().mockResolvedValue(options.longLived ?? { ok: true, token: { accessToken: 'long-token-secret', expiresIn: 5_184_000 } }),
  } as unknown as jest.Mocked<InstagramOAuthClient>;
}

function configService(overrides: Partial<EnvironmentConfig> = {}): ConfigService<EnvironmentConfig, true> {
  const values: Partial<EnvironmentConfig> = {
    META_APP_ID: 'test-meta-app-id',
    INSTAGRAM_OAUTH_REDIRECT_URI: 'https://app.test/integrations/instagram/webhook',
    INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE: false,
    ...overrides,
  };

  return {
    get: (key: keyof EnvironmentConfig) => values[key],
  } as unknown as ConfigService<EnvironmentConfig, true>;
}

interface AxelorMockOptions {
  agent?: { id: string | number } | null;
  instagramAccounts?: Array<Record<string, unknown>>;
  stateAccount?: Record<string, unknown> | null;
}

interface OAuthMockOptions {
  shortLived?: { accessToken: string; userId: string };
  longLived?: { ok: true; token: { accessToken: string; expiresIn?: number } } | { ok: false; error: { status?: number; message: string } };
}
