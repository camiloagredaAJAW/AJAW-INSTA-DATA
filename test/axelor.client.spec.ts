import { ConfigService } from '@nestjs/config';
import {
  buildAxelorCookieHeader,
  buildAxelorAuthenticatedRestHeaders,
  buildAxelorSessionHeaders,
  buildBasicAuthHeader,
  buildCreateInstagramAccountOAuthPlaceholderPayload,
  buildInstagramAccountConnectedUpdate,
  buildInstagramAccountOAuthStateUpdate,
  buildInstagramAccountSearchByChatwootLinkagePayload,
  buildInstagramAccountSearchByStatePayload,
  buildInstagramAccountSearchByInstagramUserIdPayload,
  buildInstagramAccountSearchPayload,
  DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
  DefaultAxelorClient,
  extractAxelorCookies,
  AxelorLoginTransport,
  FetchLike,
  HeadersLike,
  modelEndpoint,
} from '../src/infrastructure/axelor/axelor.client';
import { EnvironmentConfig } from '../src/config/environment';

describe('DefaultAxelorClient', () => {
  it('builds Basic Auth and model endpoints from configured namespace and model names', () => {
    expect(buildBasicAuthHeader('user', 'pass')).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    expect(modelEndpoint('https://axelor.test/', 'com.example.db', 'Agent')).toBe('https://axelor.test/ws/rest/com.example.db.Agent');
  });

  it('extracts Axelor session cookies from separate Set-Cookie headers and ignores attributes', () => {
    const headers: HeadersLike = {
      get: () => null,
      getSetCookie: () => [
        'JSESSIONID=session-id; Path=/; Secure; HttpOnly; SameSite=None',
        'TENANTID=db8; Max-Age=604800; Expires=Wed, 21 May 2026 12:00:00 GMT; Secure; HttpOnly; SameSite=None',
        'CSRF-TOKEN=csrf-token; Path=/; Secure',
      ],
    };

    expect(extractAxelorCookies(headers)).toEqual({
      jsessionId: 'session-id',
      tenantId: 'db8',
      csrfToken: 'csrf-token',
    });
  });

  it('performs login with curl --data empty-body parity and without exposing credentials in the body', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(response({ ok: true, headers: cookieHeaders() }));
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.login()).resolves.toEqual({ jsessionId: 'session-id' });

    expect(fetcher).toHaveBeenCalledWith('https://axelor.test/login.jsp', {
      method: 'POST',
      headers: { Authorization: buildBasicAuthHeader('user', 'pass') },
      body: '',
    });
    expect(fetcher.mock.calls[0][1]?.body).toBe('');
  });

  it('uses an injected login transport for login only and keeps the fetcher for later Axelor REST calls', async () => {
    const loginTransport = jest.fn<ReturnType<AxelorLoginTransport>, Parameters<AxelorLoginTransport>>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: cookieHeaders(['JSESSIONID=session-id; Path=/; HttpOnly', 'TENANTID=tenant-id; Path=/']),
    });
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(response({ body: { data: { id: 7 } } }));
    const client = new DefaultAxelorClient(configService(), fetcher, loginTransport);

    await client.login();
    await expect(client.fetchAgent(7)).resolves.toEqual({ id: 7 });

    expect(loginTransport).toHaveBeenCalledWith({
      url: 'https://axelor.test/login.jsp',
      authorization: buildBasicAuthHeader('user', 'pass'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://axelor.test/ws/rest/com.example.db.Agent/7');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: buildBasicAuthHeader('user', 'pass'), Cookie: 'JSESSIONID=session-id; TENANTID=tenant-id' }),
    );
  });

  it('treats an HTML login response body as irrelevant when Set-Cookie contains a session', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        ok: true,
        body: '<html><body>Login accepted</body></html>',
        headers: cookieHeaders(['JSESSIONID=session-id; Path=/; HttpOnly', 'TENANTID=tenant-id; Path=/', 'CSRF-TOKEN=csrf-token; Path=/']),
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.login()).resolves.toEqual({ jsessionId: 'session-id', tenantId: 'tenant-id', csrfToken: 'csrf-token' });
  });

  it('rejects a status 500 login response even when Axelor returns usable session cookies', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        ok: false,
        status: 500,
        body: '<html><body>Upstream returned an HTML page after setting the session</body></html>',
        headers: cookieHeaders(['JSESSIONID=session-id; Path=/; HttpOnly', 'TENANTID=tenant-id; Path=/']),
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.login()).rejects.toThrow('Axelor login failed with status 500');
  });

  it('rejects login responses without a usable session cookie and does not include secrets in the error', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(response({ ok: true, headers: emptyHeaders() }));
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.login()).rejects.toThrow('Axelor login did not return required session cookies');
  });

  it('does not leak Basic Auth or cookie values when an injected login transport fails', async () => {
    const loginTransport = jest.fn<ReturnType<AxelorLoginTransport>, Parameters<AxelorLoginTransport>>().mockResolvedValue({
      ok: false,
      status: 500,
      headers: cookieHeaders(['JSESSIONID=session-secret; Path=/; HttpOnly', 'TENANTID=tenant-secret; Path=/']),
    });
    const client = new DefaultAxelorClient(configService(), undefined, loginTransport);

    await expect(client.login()).rejects.toThrow('Axelor login failed with status 500');
    await expect(client.login()).rejects.not.toThrow('dXNlcjpwYXNz');
    await expect(client.login()).rejects.not.toThrow('session-secret');
    await expect(client.login()).rejects.not.toThrow('tenant-secret');
  });

  it('sends extracted login cookies on following Axelor requests', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        response({ headers: cookieHeaders(['JSESSIONID=session-id; Path=/; HttpOnly', 'TENANTID=tenant-id; Path=/', 'CSRF-TOKEN=csrf-token; Path=/']) }),
      )
      .mockResolvedValueOnce(response({ body: { data: { id: 7, chatwootApiKey: 'agent-token' } } }))
      .mockResolvedValueOnce(response({ body: { data: [{ id: 11, version: 3, agent: { id: 7 } }] } }))
      .mockResolvedValueOnce(response({ body: { data: { id: 11, version: 4 } } }));
    const client = new DefaultAxelorClient(configService(), fetcher);

    await client.login();
    await client.fetchAgent(7);
    await client.searchInstagramAccountsByAgent(7);
    await client.updateInstagramAccount(11, 3, { chatwootIntegrationStatus: 'active' });

    const expectedSessionHeaders = {
      Authorization: buildBasicAuthHeader('user', 'pass'),
      Cookie: 'JSESSIONID=session-id; TENANTID=tenant-id; CSRF-TOKEN=csrf-token',
      'X-CSRF-TOKEN': 'csrf-token',
    };
    expect(fetcher.mock.calls[1][1]?.headers).toEqual(expect.objectContaining(expectedSessionHeaders));
    expect(fetcher.mock.calls[2][1]?.headers).toEqual(expect.objectContaining(expectedSessionHeaders));
    expect(fetcher.mock.calls[3][1]?.headers).toEqual(expect.objectContaining(expectedSessionHeaders));
  });

  it('builds cookie headers from extracted Axelor cookies', () => {
    expect(buildAxelorCookieHeader({ jsessionId: 'session-id', tenantId: 'tenant-id', csrfToken: 'csrf-token' })).toBe(
      'JSESSIONID=session-id; TENANTID=tenant-id; CSRF-TOKEN=csrf-token',
    );
    expect(buildAxelorSessionHeaders({ jsessionId: 'session-id', csrfToken: 'csrf-token' })).toEqual({
      Cookie: 'JSESSIONID=session-id; CSRF-TOKEN=csrf-token',
      'X-CSRF-TOKEN': 'csrf-token',
    });
    expect(
      buildAxelorCookieHeader(
        extractAxelorCookies(cookieHeaders(['JSESSIONID=session-id; Path=/; HttpOnly', 'TENANTID=db8; Secure; SameSite=None'])),
      ),
    ).toBe('JSESSIONID=session-id; TENANTID=db8');
    expect(buildAxelorAuthenticatedRestHeaders({ username: 'user', password: 'pass' }, { jsessionId: 'session-id', tenantId: 'tenant-id' })).toEqual({
      Authorization: buildBasicAuthHeader('user', 'pass'),
      Cookie: 'JSESSIONID=session-id; TENANTID=tenant-id',
    });
  });

  it('fetches Agent and builds InstagramAccount search payloads without real calls', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(response({ body: { data: { id: 7, chatwootApiKey: 'agent-secret' } } }))
      .mockResolvedValueOnce(response({ body: { data: [{ id: 11, agent: { id: 7 } }] } }));
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.fetchAgent(7)).resolves.toEqual({ id: 7, chatwootApiKey: 'agent-secret' });
    await expect(client.searchInstagramAccountsByAgent(7)).resolves.toEqual([{ id: 11, agent: { id: 7 } }]);

    expect(fetcher.mock.calls[0][0]).toBe('https://axelor.test/ws/rest/com.example.db.Agent/7');
    expect(fetcher.mock.calls[1][0]).toBe('https://axelor.test/ws/rest/com.example.db.InstagramAccount/search');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: buildBasicAuthHeader('user', 'pass') }));
    expect(fetcher.mock.calls[1][1]?.headers).toEqual(expect.objectContaining({ Authorization: buildBasicAuthHeader('user', 'pass') }));
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(buildInstagramAccountSearchPayload(7));
  });

  it('parses Agent read responses when Axelor wraps the record in a data array', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { data: [{ id: 7, chatwootApiKey: 'agent-secret' }] },
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.fetchAgent(7)).resolves.toEqual({ id: 7, chatwootApiKey: 'agent-secret' });
  });

  it('returns null for Agent read responses with an empty data array', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(response({ body: { data: [] } }));
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.fetchAgent(7)).resolves.toBeNull();
  });

  it('searches InstagramAccount by agentId domain and includes published Chatwoot fields', () => {
    expect(buildInstagramAccountSearchPayload(7)).toEqual({
      offset: 0,
      limit: 1,
      fields: DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
      data: {
        _domain: 'self.agent.id=:agentId',
        _domainContext: { agentId: 7 },
      },
    });
    expect(DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS).toEqual(expect.arrayContaining(['instagramUserId', 'accessToken', 'agent.chatwootApiKey', 'chatwootAccountId', 'chatwootInboxId', 'chatwootChannelId']));
  });

  it('searches InstagramAccount by instagramUserId for webhook routing and returns the first match', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { data: [{ id: 11, instagramUserId: '178414000000', agent: { id: 7, chatwootApiKey: 'agent-secret' } }] },
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.findInstagramAccountByInstagramUserId('178414000000')).resolves.toEqual({
      id: 11,
      instagramUserId: '178414000000',
      agent: { id: 7, chatwootApiKey: 'agent-secret' },
    });

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(buildInstagramAccountSearchByInstagramUserIdPayload('178414000000'));
  });

  it('builds InstagramAccount search by Chatwoot linkage payload', () => {
    expect(buildInstagramAccountSearchByChatwootLinkagePayload(50, 78)).toEqual({
      offset: 0,
      limit: 1,
      fields: DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
      data: {
        _domain: 'self.chatwootAccountId=:chatwootAccountId AND self.chatwootInboxId=:chatwootInboxId',
        _domainContext: { chatwootAccountId: 50, chatwootInboxId: 78 },
      },
    });
  });

  it('builds OAuth placeholder and state search payloads for Instagram login', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(response({ body: { data: [{ id: 11, version: 3, instagramState: 'state-123' }] } }))
      .mockResolvedValueOnce(response({ body: { data: { id: 12, version: 1, instagramState: 'state-456', active: false } } }))
      .mockResolvedValueOnce(response({ body: { data: { id: 12, version: 2, instagramState: 'state-789', active: false } } }));
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.findInstagramAccountByState('state-123')).resolves.toEqual({ id: 11, version: 3, instagramState: 'state-123' });
    await expect(client.createInstagramAccount(7, 'state-456')).resolves.toEqual({ id: 12, version: 1, instagramState: 'state-456', active: false });
    await expect(client.updateInstagramAccountOAuthState(12, 1, 'state-789')).resolves.toEqual({ id: 12, version: 2, instagramState: 'state-789', active: false });

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(buildInstagramAccountSearchByStatePayload('state-123'));
    expect(fetcher.mock.calls[1][1]?.method).toBe('PUT');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(buildCreateInstagramAccountOAuthPlaceholderPayload(7, 'state-456'));
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ data: { id: 12, version: 1, ...buildInstagramAccountOAuthStateUpdate('state-789') } });
  });

  it('parses Axelor PUT create responses wrapped in a top-level status array', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({ body: [{ status: 0, data: [{ id: 12, version: 0, instagramState: 'state-456', active: false }] }] }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.createInstagramAccount(7, 'state-456')).resolves.toEqual({ id: 12, version: 0, instagramState: 'state-456', active: false });
  });

  it('builds connected account updates without OAuth state or optional empty expiry', () => {
    expect(
      buildInstagramAccountConnectedUpdate({
        instagramUserId: '178414000000',
        accessToken: 'short-lived-token',
        connectedAt: '2026-05-15T20:00:00.000Z',
      }),
    ).toEqual({
      instagramState: null,
      instagramUserId: '178414000000',
      accessToken: 'short-lived-token',
      active: true,
      connectedAt: '2026-05-15T20:00:00.000Z',
    });
  });

  it('uses id/version safe write shape for InstagramAccount updates', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { data: { id: 11, version: 4, chatwootInboxId: 22 } },
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await client.updateInstagramAccount(11, 3, {
      chatwootInboxId: 22,
      chatwootIntegrationStatus: 'active',
      chatwootLastIntegrationError: null,
    });

    expect(fetcher.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: buildBasicAuthHeader('user', 'pass') }));
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      data: {
        id: 11,
        version: 3,
        chatwootInboxId: 22,
        chatwootIntegrationStatus: 'active',
        chatwootLastIntegrationError: null,
      },
    });
  });

  it('parses InstagramAccount update responses when Axelor wraps the record in a data array', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { data: [{ id: 11, version: 4, chatwootInboxId: 22 }] },
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.updateInstagramAccount(11, 3, { chatwootInboxId: 22 })).resolves.toEqual({ id: 11, version: 4, chatwootInboxId: 22 });
  });

  it('reads InstagramAccount by id and parses Axelor data array responses', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(
      response({
        body: { data: [{ id: 11, version: 4, chatwootAccountId: 42, chatwootInboxId: 101, chatwootIntegrationStatus: 'active' }] },
      }),
    );
    const client = new DefaultAxelorClient(configService(), fetcher);

    await expect(client.readInstagramAccount(11)).resolves.toEqual({ id: 11, version: 4, chatwootAccountId: 42, chatwootInboxId: 101, chatwootIntegrationStatus: 'active' });

    expect(fetcher.mock.calls[0][0]).toBe('https://axelor.test/ws/rest/com.example.db.InstagramAccount/11');
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: buildBasicAuthHeader('user', 'pass') }));
  });
});

function configService(): ConfigService<EnvironmentConfig, true> {
  const values: EnvironmentConfig = {
    NODE_ENV: 'test',
    PORT: 3000,
    AXELOR_BASE_URL: 'https://axelor.test',
    AXELOR_LOGIN_PATH: '/login.jsp',
    AXELOR_USERNAME: 'user',
    AXELOR_PASSWORD: 'pass',
    CHATWOOT_BASE_URL: 'https://chatwoot.test',
    APP_BASE_URL: 'https://app.test',
    META_APP_ID: 'meta-app-id',
    META_APP_SECRET: 'meta-app-secret',
    INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE: false,
    AJAW_NAMESPACE: 'com.example.db',
    MODEL_NAME_AGENT: 'Agent',
    MODEL_NAME_INSTAGRAM_ACCOUNT: 'InstagramAccount',
    INTERNAL_API_KEY: 'internal-key',
    LOG_LEVEL: 'info',
  };

  return {
    get: (key: keyof EnvironmentConfig) => values[key],
  } as unknown as ConfigService<EnvironmentConfig, true>;
}

function response({ ok = true, status = 200, body = {}, headers = emptyHeaders() }: ResponseOptions) {
  return {
    ok,
    status,
    headers,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface ResponseOptions {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: HeadersLike;
}

function emptyHeaders(): HeadersLike {
  return { get: () => null };
}

function cookieHeaders(cookies = ['JSESSIONID=session-id; Path=/']): HeadersLike {
  return { get: () => null, getSetCookie: () => cookies };
}
