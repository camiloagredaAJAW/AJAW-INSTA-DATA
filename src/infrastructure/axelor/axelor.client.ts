import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpsRequest, RequestOptions } from 'node:https';
import { IncomingMessage } from 'node:http';
import { EnvironmentConfig } from '../../config/environment';

export interface AxelorSessionCookies {
  jsessionId?: string;
  tenantId?: string;
  csrfToken?: string;
}

export interface AxelorAgentRecord {
  id: string | number;
  version?: number;
  chatwootApiKey?: string;
}

export interface AxelorInstagramAccountRecord {
  id: string | number;
  version?: number;
  name?: string;
  username?: string;
  instagramUserId?: string;
  instagramState?: string | null;
  accessToken?: string;
  active?: boolean;
  connectedAt?: string;
  tokenExpiresAt?: string;
  scopes?: unknown;
  instagramScopes?: unknown;
  grantedScopes?: unknown;
  granted_scopes?: unknown;
  agent?: { id: string | number; chatwootApiKey?: string };
  chatwootAccountId?: string | number;
  chatwootInboxId?: string | number;
  chatwootChannelId?: string | number;
  chatwootChannelType?: string;
  chatwootInboxName?: string;
  chatwootInboxIdentifier?: string;
  chatwootWebhookUrl?: string;
  chatwootHmacToken?: string;
  chatwootIntegrationStatus?: string;
  chatwootLastSyncAt?: string;
  chatwootLastIntegrationError?: string | null;
}

export interface AxelorSearchOptions {
  fields?: string[];
  limit?: number;
  offset?: number;
}

export const DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS = [
  'id',
  'version',
  'name',
  'username',
  'instagramUserId',
  'instagramState',
  'accessToken',
  'active',
  'connectedAt',
  'tokenExpiresAt',
  'agent',
  'agent.chatwootApiKey',
  'chatwootAccountId',
  'chatwootInboxId',
  'chatwootChannelId',
  'chatwootChannelType',
  'chatwootInboxName',
  'chatwootInboxIdentifier',
  'chatwootWebhookUrl',
  'chatwootHmacToken',
  'chatwootIntegrationStatus',
  'chatwootLastSyncAt',
  'chatwootLastIntegrationError',
];

export interface AxelorClientConfig {
  baseUrl: string;
  loginPath: string;
  username: string;
  password: string;
  namespace: string;
  agentModelName: string;
  instagramAccountModelName: string;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: HeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HeadersLike {
  get(name: string): string | null;
  getSetCookie?(): string[];
  raw?(): Record<string, string[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<HttpResponseLike>;

export interface AxelorLoginRequest {
  url: string;
  authorization: string;
}

export interface AxelorLoginResponse {
  ok: boolean;
  status: number;
  headers: HeadersLike;
}

export type AxelorLoginTransport = (request: AxelorLoginRequest) => Promise<AxelorLoginResponse>;

export const AXELOR_FETCH = Symbol('AXELOR_FETCH');
export const AXELOR_LOGIN_TRANSPORT = Symbol('AXELOR_LOGIN_TRANSPORT');

@Injectable()
export class DefaultAxelorClient {
  readonly source = 'axelor' as const;

  private readonly fetcher: FetchLike;
  private readonly loginTransport: AxelorLoginTransport;
  private sessionCookies: AxelorSessionCookies = {};

  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    @Optional() @Inject(AXELOR_FETCH) fetcher?: FetchLike,
    @Optional() @Inject(AXELOR_LOGIN_TRANSPORT) loginTransport?: AxelorLoginTransport,
  ) {
    this.fetcher = fetcher ?? fetch;
    this.loginTransport = loginTransport ?? (fetcher ? fetchAxelorLoginTransport(fetcher) : nodeHttpsAxelorLoginTransport);
  }

  buildBasicAuthHeader(): string {
    const { username, password } = this.readConfig();
    return buildBasicAuthHeader(username, password);
  }

  modelEndpoint(modelName: string): string {
    const { namespace } = this.readConfig();
    return modelEndpoint(this.readConfig().baseUrl, namespace, modelName);
  }

  async login(): Promise<AxelorSessionCookies> {
    const config = this.readConfig();
    const response = await this.loginTransport({
      url: joinUrl(config.baseUrl, config.loginPath),
      authorization: buildBasicAuthHeader(config.username, config.password),
    });

    const cookies = extractAxelorCookies(response.headers);
    const hasUsableSessionCookie = hasRequiredSessionCookies(cookies);

    if (!response.ok) {
      throw new Error(`Axelor login failed with status ${response.status}`);
    }

    if (!hasUsableSessionCookie) {
      throw new Error('Axelor login did not return required session cookies');
    }

    this.sessionCookies = cookies;
    return cookies;
  }

  async fetchAgent(agentId: string | number): Promise<AxelorAgentRecord | null> {
    const config = this.readConfig();
    const response = await this.fetcher(`${modelEndpoint(config.baseUrl, config.namespace, config.agentModelName)}/${agentId}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.buildAuthenticatedRestHeaders(config) },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Axelor Agent fetch failed with status ${response.status}`);
    }

    return parseAxelorData<AxelorAgentRecord>(await response.json());
  }

  async searchInstagramAccountsByAgent(agentId: string | number, options: AxelorSearchOptions = {}): Promise<AxelorInstagramAccountRecord[]> {
    const config = this.readConfig();
    const response = await this.fetcher(`${modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName)}/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.buildAuthenticatedRestHeaders(config),
      },
      body: JSON.stringify(buildInstagramAccountSearchPayload(agentId, options)),
    });

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount search failed with status ${response.status}`);
    }

    return parseAxelorList<AxelorInstagramAccountRecord>(await response.json());
  }

  async findInstagramAccountByInstagramUserId(instagramUserId: string, options: AxelorSearchOptions = {}): Promise<AxelorInstagramAccountRecord | null> {
    const config = this.readConfig();
    const response = await this.fetcher(`${modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName)}/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.buildAuthenticatedRestHeaders(config),
      },
      body: JSON.stringify(buildInstagramAccountSearchByInstagramUserIdPayload(instagramUserId, options)),
    });

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount search failed with status ${response.status}`);
    }

    return parseAxelorList<AxelorInstagramAccountRecord>(await response.json())[0] ?? null;
  }

  async findInstagramAccountByChatwootLinkage(chatwootAccountId: string | number, chatwootInboxId: string | number, options: AxelorSearchOptions = {}): Promise<AxelorInstagramAccountRecord | null> {
    const config = this.readConfig();
    const response = await this.fetcher(`${modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName)}/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.buildAuthenticatedRestHeaders(config),
      },
      body: JSON.stringify(buildInstagramAccountSearchByChatwootLinkagePayload(chatwootAccountId, chatwootInboxId, options)),
    });

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount search failed with status ${response.status}`);
    }

    return parseAxelorList<AxelorInstagramAccountRecord>(await response.json())[0] ?? null;
  }

  async findInstagramAccountByState(instagramState: string, options: AxelorSearchOptions = {}): Promise<AxelorInstagramAccountRecord | null> {
    const config = this.readConfig();
    const response = await this.fetcher(`${modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName)}/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.buildAuthenticatedRestHeaders(config),
      },
      body: JSON.stringify(buildInstagramAccountSearchByStatePayload(instagramState, options)),
    });

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount search failed with status ${response.status}`);
    }

    return parseAxelorList<AxelorInstagramAccountRecord>(await response.json())[0] ?? null;
  }

  async createInstagramAccount(agentId: string | number, instagramState: string): Promise<AxelorInstagramAccountRecord> {
    const config = this.readConfig();
    const response = await this.fetcher(modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName), {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.buildAuthenticatedRestHeaders(config),
      },
      body: JSON.stringify(buildCreateInstagramAccountOAuthPlaceholderPayload(agentId, instagramState)),
    });

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount create failed with status ${response.status}`);
    }

    const created = parseAxelorData<AxelorInstagramAccountRecord>(await response.json());
    if (!created) {
      throw new Error('Axelor InstagramAccount create returned no data');
    }

    return created;
  }

  async updateInstagramAccount(id: string | number, version: number, data: Record<string, unknown>): Promise<AxelorInstagramAccountRecord> {
    const config = this.readConfig();
    const response = await this.fetcher(modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName), {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.buildAuthenticatedRestHeaders(config),
      },
      body: JSON.stringify({ data: { ...data, id, version } }),
    });

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount update failed with status ${response.status}`);
    }

    const updated = parseAxelorData<AxelorInstagramAccountRecord>(await response.json());
    if (!updated) {
      throw new Error('Axelor InstagramAccount update returned no data');
    }

    return updated;
  }

  async updateInstagramAccountOAuthState(id: string | number, version: number, instagramState: string | null): Promise<AxelorInstagramAccountRecord> {
    return this.updateInstagramAccount(id, version, buildInstagramAccountOAuthStateUpdate(instagramState));
  }

  async readInstagramAccount(id: string | number): Promise<AxelorInstagramAccountRecord | null> {
    const config = this.readConfig();
    const response = await this.fetcher(`${modelEndpoint(config.baseUrl, config.namespace, config.instagramAccountModelName)}/${id}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.buildAuthenticatedRestHeaders(config) },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Axelor InstagramAccount read failed with status ${response.status}`);
    }

    return parseAxelorData<AxelorInstagramAccountRecord>(await response.json());
  }

  private readConfig(): AxelorClientConfig {
    return {
      baseUrl: this.configService.get('AXELOR_BASE_URL', { infer: true }),
      loginPath: this.configService.get('AXELOR_LOGIN_PATH', { infer: true }),
      username: this.configService.get('AXELOR_USERNAME', { infer: true }),
      password: this.configService.get('AXELOR_PASSWORD', { infer: true }),
      namespace: this.configService.get('AJAW_NAMESPACE', { infer: true }),
      agentModelName: this.configService.get('MODEL_NAME_AGENT', { infer: true }),
      instagramAccountModelName: this.configService.get('MODEL_NAME_INSTAGRAM_ACCOUNT', { infer: true }),
    };
  }

  private buildAuthenticatedRestHeaders(config: AxelorClientConfig): Record<string, string> {
    return buildAxelorAuthenticatedRestHeaders(config, this.sessionCookies);
  }
}

export type AxelorClient = DefaultAxelorClient;

export function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function fetchAxelorLoginTransport(fetcher: FetchLike): AxelorLoginTransport {
  return async ({ url, authorization }) => {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
      },
      body: '',
    });

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
    };
  };
}

export function nodeHttpsAxelorLoginTransport({ url, authorization }: AxelorLoginRequest): Promise<AxelorLoginResponse> {
  const loginUrl = new URL(url);
  if (loginUrl.protocol !== 'https:') {
    throw new Error('Axelor login transport requires an HTTPS URL');
  }

  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: loginUrl.protocol,
      hostname: loginUrl.hostname,
      port: loginUrl.port,
      path: `${loginUrl.pathname}${loginUrl.search}`,
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Length': '0',
      },
    };

    const request = httpsRequest(options, (response: IncomingMessage) => {
      response.resume();
      response.on('end', () => {
        resolve({
          ok: isSuccessStatus(response.statusCode),
          status: response.statusCode ?? 0,
          headers: nodeResponseHeaders(response),
        });
      });
    });

    request.on('error', reject);
    request.end('');
  });
}

export function modelEndpoint(baseUrl: string, namespace: string, modelName: string): string {
  return joinUrl(baseUrl, `/ws/rest/${namespace}.${modelName}`);
}

export function buildInstagramAccountSearchPayload(agentId: string | number, options: AxelorSearchOptions = {}): Record<string, unknown> {
  return {
    offset: options.offset ?? 0,
    limit: options.limit ?? 1,
    fields: options.fields ?? DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
    data: {
      _domain: 'self.agent.id=:agentId',
      _domainContext: { agentId },
    },
  };
}

export function buildInstagramAccountSearchByInstagramUserIdPayload(instagramUserId: string, options: AxelorSearchOptions = {}): Record<string, unknown> {
  return {
    offset: options.offset ?? 0,
    limit: options.limit ?? 1,
    fields: options.fields ?? DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
    data: {
      _domain: 'self.instagramUserId=:instagramUserId',
      _domainContext: { instagramUserId },
    },
  };
}

export function buildInstagramAccountSearchByChatwootLinkagePayload(chatwootAccountId: string | number, chatwootInboxId: string | number, options: AxelorSearchOptions = {}): Record<string, unknown> {
  return {
    fields: options.fields ?? DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
    limit: options.limit ?? 1,
    offset: options.offset ?? 0,
    data: {
      _domain: 'self.chatwootAccountId=:chatwootAccountId AND self.chatwootInboxId=:chatwootInboxId',
      _domainContext: { chatwootAccountId, chatwootInboxId },
    },
  };
}

export function buildInstagramAccountSearchByStatePayload(instagramState: string, options: AxelorSearchOptions = {}): Record<string, unknown> {
  return {
    offset: options.offset ?? 0,
    limit: options.limit ?? 1,
    fields: options.fields ?? DEFAULT_INSTAGRAM_ACCOUNT_SEARCH_FIELDS,
    data: {
      _domain: 'self.instagramState=:instagramState',
      _domainContext: { instagramState },
    },
  };
}

export function buildCreateInstagramAccountOAuthPlaceholderPayload(agentId: string | number, instagramState: string): Record<string, unknown> {
  return {
    data: {
      agent: { id: agentId },
      instagramState,
      active: false,
    },
  };
}

export function buildInstagramAccountOAuthStateUpdate(instagramState: string | null): Record<string, unknown> {
  return {
    instagramState,
    active: false,
  };
}

export function buildInstagramAccountConnectedUpdate(input: {
  instagramUserId: string;
  accessToken: string;
  connectedAt: string;
  tokenExpiresAt?: string;
  name?: string;
  username?: string;
}): Record<string, unknown> {
  return {
    instagramState: null,
    instagramUserId: input.instagramUserId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.username ? { username: input.username } : {}),
    accessToken: input.accessToken,
    active: true,
    connectedAt: input.connectedAt,
    ...(input.tokenExpiresAt ? { tokenExpiresAt: input.tokenExpiresAt } : {}),
  };
}

export function extractAxelorCookies(headers: HeadersLike): AxelorSessionCookies {
  const cookies = getSetCookieHeaders(headers).flatMap((header) => header.split(/,(?=\s*[^;,]+=)/));
  const result: AxelorSessionCookies = {};

  for (const cookie of cookies) {
    const [pair] = cookie.trim().split(';');
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const name = pair.slice(0, separatorIndex).trim().toUpperCase();
    const value = pair.slice(separatorIndex + 1).trim();

    if (name === 'JSESSIONID') {
      result.jsessionId = value;
    }
    if (name === 'TENANTID') {
      result.tenantId = value;
    }
    if (name === 'CSRF-TOKEN') {
      result.csrfToken = value;
    }
  }

  return result;
}

export function buildAxelorSessionHeaders(cookies: AxelorSessionCookies): Record<string, string> {
  const cookieHeader = buildAxelorCookieHeader(cookies);
  if (!cookieHeader) {
    return {};
  }

  return {
    Cookie: cookieHeader,
    ...(cookies.csrfToken ? { 'X-CSRF-TOKEN': cookies.csrfToken } : {}),
  };
}

export function buildAxelorAuthenticatedRestHeaders(config: Pick<AxelorClientConfig, 'username' | 'password'>, cookies: AxelorSessionCookies): Record<string, string> {
  return {
    Authorization: buildBasicAuthHeader(config.username, config.password),
    ...buildAxelorSessionHeaders(cookies),
  };
}

export function buildAxelorCookieHeader(cookies: AxelorSessionCookies): string {
  return [
    cookies.jsessionId ? `JSESSIONID=${cookies.jsessionId}` : null,
    cookies.tenantId ? `TENANTID=${cookies.tenantId}` : null,
    cookies.csrfToken ? `CSRF-TOKEN=${cookies.csrfToken}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function hasRequiredSessionCookies(cookies: AxelorSessionCookies): boolean {
  return Boolean(cookies.jsessionId);
}

function isSuccessStatus(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 200 && status < 300;
}

function nodeResponseHeaders(response: IncomingMessage): HeadersLike {
  return {
    get: (name: string) => {
      const value = response.headers[name.toLowerCase()];
      if (Array.isArray(value)) {
        return value.join(', ');
      }
      return value ?? null;
    },
    getSetCookie: () => {
      const value = response.headers['set-cookie'];
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    },
  };
}

function getSetCookieHeaders(headers: HeadersLike): string[] {
  if (headers.getSetCookie) {
    return headers.getSetCookie();
  }

  const rawCookies = headers.raw?.()['set-cookie'];
  if (rawCookies) {
    return rawCookies;
  }

  const singleHeader = headers.get('set-cookie');
  return singleHeader ? [singleHeader] : [];
}

function parseAxelorData<T>(body: unknown): T | null {
  if (Array.isArray(body)) {
    const first = body.find(isRecord);
    if (first && Array.isArray(first.data)) {
      return (first.data[0] as T | undefined) ?? null;
    }

    if (first && isRecord(first.data)) {
      return first.data as T;
    }
  }

  if (!isRecord(body)) {
    return null;
  }

  if (Array.isArray(body.data)) {
    return (body.data[0] as T | undefined) ?? null;
  }

  if (isRecord(body.data)) {
    return body.data as T;
  }

  return body as T;
}

function parseAxelorList<T>(body: unknown): T[] {
  if (!isRecord(body)) {
    return [];
  }

  if (Array.isArray(body.data)) {
    return body.data as T[];
  }

  if (isRecord(body.data) && Array.isArray(body.data.records)) {
    return body.data.records as T[];
  }

  return [];
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
