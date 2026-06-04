import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentConfig } from '../../config/environment';
import { FetchLike } from '../axelor/axelor.client';

export interface ChatwootProfile {
  account_id?: number;
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
  callback_webhook_url?: string;
  inbox_identifier?: string;
  hmac_token?: string;
  secret?: string;
}

export interface CreateChatwootApiInboxPayload {
  name: string;
  channel?: {
    webhook_url?: string;
    website_url?: string;
    welcome_title?: string;
    welcome_tagline?: string;
    widget_color?: string;
  };
}

export interface UpdateChatwootApiInboxPayload {
  channel: {
    webhook_url: string;
  };
}

export interface ChatwootContactSummary {
  id: number;
  identifier?: string;
  name?: string;
  contact_inboxes?: ChatwootContactInboxLink[];
}

export interface ChatwootContactInboxLink {
  id?: number;
  source_id?: string;
  inbox?: { id?: number };
}

export interface ChatwootContactInboxSummary {
  id?: number;
  source_id?: string;
}

export interface ChatwootConversationSummary {
  id: number;
  source_id?: string;
  inbox_id?: number;
  contact_inbox?: {
    source_id?: string;
  };
  status?: string;
  custom_attributes?: Record<string, unknown>;
  messages?: ChatwootMessageSummary[];
}

export interface ChatwootMessageSummary {
  id: number;
  source_id?: string;
  content?: string;
}

export interface CreateChatwootContactPayload {
  inbox_id: number;
  identifier: string;
  name: string;
  avatar_url?: string;
  additional_attributes?: Record<string, unknown>;
}

export interface UpdateChatwootContactPayload {
  name?: string;
  avatar_url?: string;
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
  message_type?: 'incoming' | 'outgoing';
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

  async updateApiInbox(accountId: number, apiAccessToken: string, inboxId: number, payload: UpdateChatwootApiInboxPayload): Promise<ChatwootApiChannelSummary> {
    const path = `/api/v1/accounts/${accountId}/inboxes/${inboxId}`;
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, path), {
      method: 'PUT',
      headers: {
        ...buildChatwootAuthHeaders(apiAccessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot API inbox update request failed: method=PUT path=${path} status=${response.status}`);
    }

    return parseInbox(await response.json());
  }

  async createContact(accountId: number, apiAccessToken: string, payload: CreateChatwootContactPayload): Promise<ChatwootContactSummary> {
    const response = await this.postJson(accountId, apiAccessToken, '/contacts', payload);
    return parseIdSummary(await response.json(), 'Chatwoot contact response is missing id');
  }

  async updateContact(accountId: number, apiAccessToken: string, contactId: number, payload: UpdateChatwootContactPayload): Promise<void> {
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, `/api/v1/accounts/${accountId}/contacts/${contactId}`), {
      method: 'PUT',
      headers: {
        ...buildChatwootAuthHeaders(apiAccessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot contact update request failed: method=PUT path=/api/v1/accounts/${accountId}/contacts/${contactId} status=${response.status}`);
    }
  }

  async searchContacts(accountId: number, apiAccessToken: string, query: string): Promise<ChatwootContactSummary[]> {
    const path = `/api/v1/accounts/${accountId}/contacts/search`;
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, `${path}?q=${encodeURIComponent(query)}`), {
      method: 'GET',
      headers: buildChatwootAuthHeaders(apiAccessToken),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot contact search request failed: method=GET path=${path} status=${response.status}`);
    }

    return parseContactList(await response.json());
  }

  async createContactInbox(accountId: number, apiAccessToken: string, payload: CreateChatwootContactInboxPayload): Promise<ChatwootContactInboxSummary> {
    const response = await this.postJson(accountId, apiAccessToken, `/contacts/${payload.contact_id}/contact_inboxes`, {
      inbox_id: payload.inbox_id,
      source_id: payload.source_id,
    });
    return parseContactInboxSummary(await response.json());
  }

  async createConversation(accountId: number, apiAccessToken: string, payload: CreateChatwootConversationPayload): Promise<ChatwootConversationSummary> {
    const response = await this.postJson(accountId, apiAccessToken, '/conversations', payload);
    return parseIdSummary(await response.json(), 'Chatwoot conversation response is missing id');
  }

  async listContactConversations(accountId: number, apiAccessToken: string, contactId: number): Promise<ChatwootConversationSummary[]> {
    const path = `/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`;
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, path), {
      method: 'GET',
      headers: buildChatwootAuthHeaders(apiAccessToken),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot contact conversations request failed: method=GET path=${path} status=${response.status}`);
    }

    return parseConversationList(await response.json());
  }

  async createIncomingMessage(
    accountId: number,
    apiAccessToken: string,
    conversationId: number,
    payload: CreateChatwootIncomingMessagePayload,
  ): Promise<ChatwootMessageSummary> {
    const response = await this.postJson(accountId, apiAccessToken, `/conversations/${conversationId}/messages`, {
      ...payload,
      message_type: payload.message_type ?? 'incoming',
    });
    return parseIdSummary(await response.json(), 'Chatwoot message response is missing id');
  }

  async listConversationMessages(accountId: number, apiAccessToken: string, conversationId: number): Promise<ChatwootMessageSummary[]> {
    const path = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, path), {
      method: 'GET',
      headers: buildChatwootAuthHeaders(apiAccessToken),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot conversation messages request failed: method=GET path=${path} status=${response.status}`);
    }

    return parseMessageList(await response.json());
  }

  async getConversation(accountId: number, apiAccessToken: string, conversationId: number): Promise<ChatwootConversationSummary> {
    const path = `/api/v1/accounts/${accountId}/conversations/${conversationId}`;
    const response = await this.fetcher(joinUrl(this.readConfig().baseUrl, path), {
      method: 'GET',
      headers: buildChatwootAuthHeaders(apiAccessToken),
    });

    if (!response.ok) {
      throw new Error(`Chatwoot conversation request failed: method=GET path=${path} status=${response.status}`);
    }

    return parseConversation(await response.json());
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
      throw new Error(`Chatwoot API request failed: method=POST path=/api/v1/accounts/${accountId}${path} status=${response.status}`);
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
  if (!isRecord(body)) {
    throw new Error('Chatwoot profile response is missing account_id');
  }

  const accountId = optionalNumber(body.account_id);
  const accounts = parseProfileAccounts(body.accounts);
  if (accountId === undefined && (!accounts || accounts.length === 0)) {
    throw new Error('Chatwoot profile response is missing account_id');
  }

  return {
    account_id: accountId,
    accounts,
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
    callback_webhook_url: optionalString(body.callback_webhook_url),
    inbox_identifier: optionalString(body.inbox_identifier),
    hmac_token: optionalString(body.hmac_token),
    secret: optionalString(body.secret),
  };
}

function parseIdSummary<T extends { id: number; source_id?: string; identifier?: string }>(body: unknown, missingIdMessage: string): T {
  const record = unwrapIdRecord(body);
  if (!isRecord(record) || typeof record.id !== 'number') {
    throw new Error(missingIdMessage);
  }

  const contactInboxes = parseContactInboxLinks(record.contact_inboxes);
  const name = optionalString(record.name);
  return {
    id: record.id,
    source_id: optionalString(record.source_id),
    identifier: optionalString(record.identifier),
    ...(name ? { name } : {}),
    ...(contactInboxes ? { contact_inboxes: contactInboxes } : {}),
  } as T;
}

function parseMessageList(body: unknown): ChatwootMessageSummary[] {
  const payload = unwrapPayload(body);
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'number') {
      return [];
    }

    return [{ id: item.id, source_id: optionalString(item.source_id), content: optionalString(item.content) }];
  });
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

    const name = optionalString(item.name);
    return [
      {
        id: item.id,
        identifier: optionalString(item.identifier),
        ...(name ? { name } : {}),
        contact_inboxes: parseContactInboxLinks(item.contact_inboxes),
      },
    ];
  });
}

function parseContactInboxSummary(body: unknown): ChatwootContactInboxSummary {
  const record = unwrapIdRecord(body);
  if (!isRecord(record)) {
    throw new Error('Chatwoot contact_inbox response is missing source_id');
  }

  const sourceId = optionalString(record.source_id);
  if (!sourceId) {
    throw new Error('Chatwoot contact_inbox response is missing source_id');
  }

  return {
    id: optionalNumber(record.id),
    source_id: sourceId,
  };
}

function parseConversationList(body: unknown): ChatwootConversationSummary[] {
  const payload = unwrapPayload(body);
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item) => {
    const conversation = parseConversationSummary(item);
    return conversation ? [conversation] : [];
  });
}

function parseConversation(body: unknown): ChatwootConversationSummary {
  if (!isRecord(body) || typeof body.id !== 'number') {
    throw new Error('Chatwoot conversation response is missing id');
  }

  return {
    id: body.id,
    source_id: conversationSourceId(body),
    inbox_id: conversationInboxId(body),
    contact_inbox: conversationContactInbox(body),
    status: optionalString(body.status),
    custom_attributes: isRecord(body.custom_attributes) ? body.custom_attributes : undefined,
    messages: parseMessageList(body.messages),
  };
}

function parseConversationSummary(body: unknown): ChatwootConversationSummary | null {
  const record = unwrapIdRecord(body);
  if (!isRecord(record) || typeof record.id !== 'number') {
    return null;
  }

  return {
    id: record.id,
    source_id: conversationSourceId(record),
    inbox_id: conversationInboxId(record),
    contact_inbox: conversationContactInbox(record),
    status: optionalString(record.status),
    custom_attributes: isRecord(record.custom_attributes) ? record.custom_attributes : undefined,
  };
}

function conversationSourceId(record: Record<string, unknown>): string | undefined {
  return optionalString(record.source_id) ?? conversationContactInbox(record)?.source_id;
}

function conversationInboxId(record: Record<string, unknown>): number | undefined {
  return optionalNumber(record.inbox_id) ?? (isRecord(record.inbox) ? optionalNumber(record.inbox.id) : undefined);
}

function conversationContactInbox(record: Record<string, unknown>): { source_id?: string } | undefined {
  if (!isRecord(record.contact_inbox)) {
    return undefined;
  }

  return { source_id: optionalString(record.contact_inbox.source_id) };
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
    return [{ id: optionalNumber(item.id), source_id: optionalString(item.source_id), inbox }];
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
