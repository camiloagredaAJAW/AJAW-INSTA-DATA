import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentConfig } from '../../config/environment';
import { FetchLike } from '../axelor/axelor.client';

export interface ChatwootProfile {
  account_id: number;
  accounts?: ChatwootProfileAccount[];
}

export interface ChatwootProfileAccount {
  id: number;
  name?: string;
}

export interface ChatwootApiChannelSummary {
  id: number;
  channel_id?: number;
  name?: string;
  channel_type?: string;
  webhook_url?: string;
  inbox_identifier?: string;
  hmac_token?: string;
}

export interface CreateChatwootApiInboxPayload {
  name: string;
  channel?: {
    website_url?: string;
    welcome_title?: string;
    welcome_tagline?: string;
    widget_color?: string;
  };
}

export interface ChatwootContactSummary {
  id: number;
  identifier?: string;
  contact_inboxes?: ChatwootContactInboxLink[];
}

export interface ChatwootContactInboxLink {
  source_id?: string;
  inbox?: { id?: number };
}

export interface ChatwootContactInboxSummary {
  id: number;
  source_id?: string;
}

export interface ChatwootConversationSummary {
  id: number;
  source_id?: string;
}

export interface ChatwootMessageSummary {
  id: number;
  source_id?: string;
}

export interface CreateChatwootContactPayload {
  inbox_id: number;
  identifier: string;
  name: string;
  additional_attributes?: Record<string, unknown>;
}

export interface CreateChatwootContactInboxPayload {
  contact_id: number;
  inbox_id: number;
  source_id: string;
}

export interface CreateChatwootConversationPayload {
  inbox_id: number;
  contact_id: number;
  source_id: string;
  contact_inbox_id?: number;
  custom_attributes?: Record<string, unknown>;
}

export interface CreateChatwootIncomingMessagePayload {
  content: string;
  source_id: string;
  content_attributes?: Record<string, unknown>;
}

export interface ChatwootClientConfig {
  baseUrl: string;
}

export const CHATWOOT_FETCH = Symbol('CHATWOOT_FETCH');

@Injectable()
export class DefaultChatwootClient {
  readonly source = 'chatwoot' as const;

  private readonly fetcher: FetchLike;

  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    @Optional() @Inject(CHATWOOT_FETCH) fetcher?: FetchLike,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  async getProfile(apiAccessToken: string): Promise<ChatwootProfile> {
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, '/api/v1/profile'), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        api_access_token: apiAccessToken,
      },
    });

    if (!response.ok) {
      throw new Error(`Chatwoot profile request failed with status ${response.status}`);
    }

    return parseProfile(await response.json());
  }

  async listInboxes(accountId: number, apiAccessToken: string): Promise<ChatwootApiChannelSummary[]> {
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, `/api/v1/accounts/${accountId}/inboxes`), {
      method: 'GET',
      headers: buildChatwootAuthHeaders(apiAccessToken),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot inbox list request failed with status ${response.status}`);
    }

    return parseInboxList(await response.json());
  }

  async createApiInbox(accountId: number, apiAccessToken: string, payload: CreateChatwootApiInboxPayload): Promise<ChatwootApiChannelSummary> {
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, `/api/v1/accounts/${accountId}/inboxes`), {
      method: 'POST',
      headers: {
        ...buildChatwootAuthHeaders(apiAccessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildCreateApiInboxBody(payload)),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot API inbox create request failed with status ${response.status}`);
    }

    return parseInbox(await response.json());
  }

  async createContact(accountId: number, apiAccessToken: string, payload: CreateChatwootContactPayload): Promise<ChatwootContactSummary> {
    const response = await this.postJson(accountId, apiAccessToken, '/contacts', payload);
    return parseIdSummary(await response.json(), 'Chatwoot contact response is missing id');
  }

  async searchContacts(accountId: number, apiAccessToken: string, query: string): Promise<ChatwootContactSummary[]> {
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, `/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(query)}`), {
      method: 'GET',
      headers: buildChatwootAuthHeaders(apiAccessToken),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot contact search request failed with status ${response.status}`);
    }

    return parseContactList(await response.json());
  }

  async createContactInbox(accountId: number, apiAccessToken: string, payload: CreateChatwootContactInboxPayload): Promise<ChatwootContactInboxSummary> {
    const response = await this.postJson(accountId, apiAccessToken, '/contact_inboxes', payload);
    return parseIdSummary(await response.json(), 'Chatwoot contact_inbox response is missing id');
  }

  async createConversation(accountId: number, apiAccessToken: string, payload: CreateChatwootConversationPayload): Promise<ChatwootConversationSummary> {
    const response = await this.postJson(accountId, apiAccessToken, '/conversations', payload);
    return parseIdSummary(await response.json(), 'Chatwoot conversation response is missing id');
  }

  async createIncomingMessage(
    accountId: number,
    apiAccessToken: string,
    conversationId: number,
    payload: CreateChatwootIncomingMessagePayload,
  ): Promise<ChatwootMessageSummary> {
    const response = await this.postJson(accountId, apiAccessToken, `/conversations/${conversationId}/messages`, {
      ...payload,
      message_type: 'incoming',
    });
    return parseIdSummary(await response.json(), 'Chatwoot message response is missing id');
  }

  private readConfig(): ChatwootClientConfig {
    return {
      baseUrl: this.configService.get('CHATWOOT_BASE_URL', { infer: true }),
    };
  }

  private async postJson(accountId: number, apiAccessToken: string, path: string, payload: object): Promise<Awaited<ReturnType<FetchLike>>> {
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, `/api/v1/accounts/${accountId}${path}`), {
      method: 'POST',
      headers: {
        ...buildChatwootAuthHeaders(apiAccessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot API request failed with status ${response.status}`);
    }

    return response;
  }
}

export type ChatwootClient = DefaultChatwootClient;

export function buildChatwootAuthHeaders(apiAccessToken: string): Record<string, string> {
  return {
    Accept: 'application/json',
    api_access_token: apiAccessToken,
  };
}

export function buildCreateApiInboxBody(payload: CreateChatwootApiInboxPayload): Record<string, unknown> {
  return {
    name: payload.name,
    channel: {
      type: 'api',
      ...(payload.channel ?? {}),
    },
  };
}

export function isChatwootApiChannelInbox(inbox: ChatwootApiChannelSummary): boolean {
  return inbox.channel_type === 'Channel::Api';
}

function parseProfile(body: unknown): ChatwootProfile {
  if (!isRecord(body) || typeof body.account_id !== 'number') {
    throw new Error('Chatwoot profile response is missing account_id');
  }

  return {
    account_id: body.account_id,
    accounts: parseProfileAccounts(body.accounts),
  };
}

function parseProfileAccounts(value: unknown): ChatwootProfileAccount[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter(isRecord).flatMap((account) => {
    if (typeof account.id !== 'number') {
      return [];
    }

    return [{ id: account.id, name: optionalString(account.name) }];
  });
}

function parseInboxList(body: unknown): ChatwootApiChannelSummary[] {
  if (Array.isArray(body)) {
    return body.map(parseInbox);
  }

  if (!isRecord(body)) {
    return [];
  }

  if (Array.isArray(body.payload)) {
    return body.payload.map(parseInbox);
  }

  if (Array.isArray(body.data)) {
    return body.data.map(parseInbox);
  }

  return [];
}

function parseInbox(body: unknown): ChatwootApiChannelSummary {
  if (!isRecord(body) || typeof body.id !== 'number') {
    throw new Error('Chatwoot inbox response is missing id');
  }

  return {
    id: body.id,
    channel_id: optionalNumber(body.channel_id),
    name: optionalString(body.name),
    channel_type: optionalString(body.channel_type),
    webhook_url: optionalString(body.webhook_url),
    inbox_identifier: optionalString(body.inbox_identifier),
    hmac_token: optionalString(body.hmac_token),
  };
}

function parseIdSummary<T extends { id: number; source_id?: string; identifier?: string }>(body: unknown, missingIdMessage: string): T {
  const record = unwrapIdRecord(body);
  if (!isRecord(record) || typeof record.id !== 'number') {
    throw new Error(missingIdMessage);
  }

  const contactInboxes = parseContactInboxLinks(record.contact_inboxes);
  return {
    id: record.id,
    source_id: optionalString(record.source_id),
    identifier: optionalString(record.identifier),
    ...(contactInboxes ? { contact_inboxes: contactInboxes } : {}),
  } as T;
}

function parseContactList(body: unknown): ChatwootContactSummary[] {
  const payload = unwrapPayload(body);
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'number') {
      return [];
    }

    return [
      {
        id: item.id,
        identifier: optionalString(item.identifier),
        contact_inboxes: parseContactInboxLinks(item.contact_inboxes),
      },
    ];
  });
}

function parseContactInboxLinks(value: unknown): ChatwootContactInboxLink[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const inbox = isRecord(item.inbox) ? { id: optionalNumber(item.inbox.id) } : undefined;
    return [{ source_id: optionalString(item.source_id), inbox }];
  });
}

function unwrapIdRecord(body: unknown): unknown {
  const payload = unwrapPayload(body);
  if (isRecord(payload) && typeof payload.id === 'number') {
    return payload;
  }

  if (Array.isArray(payload) && isRecord(payload[0])) {
    return payload[0];
  }

  if (isRecord(payload) && isRecord(payload.contact)) {
    return payload.contact;
  }

  return payload;
}

function unwrapPayload(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  if (Array.isArray(body.payload)) {
    return body.payload;
  }
  if (isRecord(body.payload)) {
    return body.payload;
  }
  if (Array.isArray(body.data)) {
    return body.data;
  }
  if (isRecord(body.data)) {
    return body.data;
  }
  return body;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
