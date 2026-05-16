import { Injectable, Logger } from '@nestjs/common';
import { IntegrationStatus } from '../domain/integrationStatus';
import { AxelorInstagramAccountRecord, DefaultAxelorClient } from '../infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../infrastructure/chatwoot/chatwoot.client';
import { redactText } from '../shared/redaction';
import {
  InstagramWebhookDeliveredEvent,
  InstagramWebhookFailure,
  InstagramWebhookIgnoredEvent,
  InstagramWebhookRouteRequest,
  InstagramWebhookRouteResult,
  NormalizedInstagramWebhookEvent,
} from './ports/instagram-webhook.port';

const REQUIRED_INSTAGRAM_SCOPES = ['instagram_business_manage_messages', 'instagram_manage_comments'] as const;

@Injectable()
export class InstagramWebhookRoutingService {
  private readonly logger = new Logger(InstagramWebhookRoutingService.name);

  constructor(
    private readonly axelorClient: DefaultAxelorClient,
    private readonly chatwootClient: DefaultChatwootClient,
  ) {}

  async route(request: InstagramWebhookRouteRequest): Promise<InstagramWebhookRouteResult> {
    const events = normalizeInstagramWebhookPayload(request.payload);
    const ignored: InstagramWebhookIgnoredEvent[] = [];
    const failures: InstagramWebhookFailure[] = [];
    const processed: InstagramWebhookDeliveredEvent[] = [];
    const seenEvents = new Set<string>();

    if (events.length === 0) {
      this.logger.warn('Instagram webhook ignored: no supported DM/comment events found');
      return { status: 'ignored', processed, ignored: [{ reason: 'no_supported_events' }], failures };
    }

    this.logger.log(
      `Instagram webhook received: events=${events.length} kinds=${uniqueValues(events.map((event) => event.kind)).join(',')} instagramAccountIds=${uniqueValues(
        events.map((event) => event.instagramAccountId),
      ).join(',')}`,
    );

    await this.axelorClient.login();

    for (const event of events) {
      if (seenEvents.has(event.sourceEventId)) {
        ignored.push({ sourceEventId: event.sourceEventId, reason: 'duplicate_event_in_payload' });
        continue;
      }
      seenEvents.add(event.sourceEventId);

      try {
        const account = await this.axelorClient.findInstagramAccountByInstagramUserId(event.instagramAccountId);
        const scopeFailure = instagramScopePreconditionFailure(account);
        if (scopeFailure) {
          failures.push({ sourceEventId: event.sourceEventId, classification: 'non_retriable', reason: scopeFailure });
          this.logger.warn(`Instagram webhook event not routed: kind=${event.kind} sourceEventId=${event.sourceEventId} reason=${scopeFailure}`);
          continue;
        }

        const routableAccount = await this.resolveRoutableAccount(account);
        if (!routableAccount) {
          const reason = routingPreconditionFailure(account);
          failures.push({ sourceEventId: event.sourceEventId, classification: 'non_retriable', reason });
          this.logger.warn(`Instagram webhook event not routed: kind=${event.kind} sourceEventId=${event.sourceEventId} reason=${reason}`);
          continue;
        }

        const delivered = await this.deliverEvent(event, routableAccount);
        processed.push(delivered);
        this.logger.log(
          `Instagram webhook event routed: kind=${event.kind} sourceEventId=${event.sourceEventId} conversationSourceId=${delivered.conversationSourceId}`,
        );
      } catch (error) {
        const reason = redactText(error instanceof Error ? error.message : String(error));
        failures.push({ sourceEventId: event.sourceEventId, classification: 'retriable', reason });
        this.logger.error(`Instagram webhook event failed: kind=${event.kind} sourceEventId=${event.sourceEventId} reason=${reason}`);
      }
    }

    const result: InstagramWebhookRouteResult = {
      status: failures.length > 0 ? 'failed' : processed.length > 0 ? 'processed' : 'ignored',
      processed,
      ignored,
      failures,
    };

    this.logger.log(
      `Instagram webhook routing completed: status=${result.status} processed=${processed.length} ignored=${ignored.length} failures=${failures.length}`,
    );

    return result;
  }

  private async deliverEvent(event: NormalizedInstagramWebhookEvent, account: RoutableInstagramAccount): Promise<InstagramWebhookDeliveredEvent> {
    const apiKey = account.agent.chatwootApiKey;
    const chatwootAccountId = toPositiveInteger(account.chatwootAccountId, 'chatwootAccountId');
    const chatwootInboxId = toPositiveInteger(account.chatwootInboxId, 'chatwootInboxId');
    const contactSourceId = buildContactSourceId(event.senderId);
    const contactInboxSourceId = buildContactInboxSourceId(event.instagramAccountId, event.senderId);
    const conversationSourceId = buildConversationSourceId(event);
    const messageSourceId = buildMessageSourceId(event.sourceEventId);

    const contact = await this.chatwootClient.createContact(chatwootAccountId, apiKey, {
      identifier: contactSourceId,
      name: event.senderName ?? `Instagram user ${event.senderId}`,
      additional_attributes: {
        instagram_sender_id: event.senderId,
        instagram_account_id: event.instagramAccountId,
      },
    });
    const contactInbox = await this.chatwootClient.createContactInbox(chatwootAccountId, apiKey, {
      contact_id: contact.id,
      inbox_id: chatwootInboxId,
      source_id: contactInboxSourceId,
    });
    const conversation = await this.chatwootClient.createConversation(chatwootAccountId, apiKey, {
      inbox_id: chatwootInboxId,
      contact_id: contact.id,
      source_id: conversationSourceId,
      contact_inbox_id: contactInbox.id,
      custom_attributes: buildConversationAttributes(event),
    });
    await this.chatwootClient.createIncomingMessage(chatwootAccountId, apiKey, conversation.id, {
      content: buildVisibleMessageContent(event),
      source_id: messageSourceId,
      content_attributes: buildMessageAttributes(event),
    });

    return { kind: event.kind, sourceEventId: event.sourceEventId, conversationSourceId, messageSourceId };
  }

  private async resolveRoutableAccount(account: AxelorInstagramAccountRecord | null): Promise<RoutableInstagramAccount | null> {
    if (isRoutableInstagramAccount(account)) {
      return account;
    }

    if (!account || account.chatwootIntegrationStatus && account.chatwootIntegrationStatus !== IntegrationStatus.Active) {
      return null;
    }

    if (!toPositiveIntegerOrNull(account.chatwootAccountId) || !toPositiveIntegerOrNull(account.chatwootInboxId) || !account.agent?.id) {
      return null;
    }

    const agent = await this.axelorClient.fetchAgent(account.agent.id);
    if (!agent?.chatwootApiKey) {
      return null;
    }

    return { ...account, agent: { ...account.agent, chatwootApiKey: agent.chatwootApiKey } };
  }
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function normalizeInstagramWebhookPayload(payload: unknown): NormalizedInstagramWebhookEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) {
    return [];
  }

  return payload.entry.filter(isRecord).flatMap((entry) => normalizeEntry(entry));
}

export function buildContactSourceId(senderId: string): string {
  return `instagram:user:${senderId}`;
}

export function buildContactInboxSourceId(instagramAccountId: string, senderId: string): string {
  return `ig:${instagramAccountId}:user:${senderId}`;
}

export function buildConversationSourceId(event: NormalizedInstagramWebhookEvent): string {
  return event.kind === 'comment' ? `ig:comment:${event.sourceEventId}` : `ig:dm:${event.instagramAccountId}:${event.senderId}`;
}

export function buildMessageSourceId(sourceEventId: string): string {
  return `ig:event:${sourceEventId}`;
}

function normalizeEntry(entry: Record<string, unknown>): NormalizedInstagramWebhookEvent[] {
  const instagramAccountId = stringValue(entry.id);
  if (!instagramAccountId) {
    return [];
  }

  return [...normalizeMessagingEvents(entry, instagramAccountId), ...normalizeCommentChanges(entry, instagramAccountId)];
}

function normalizeMessagingEvents(entry: Record<string, unknown>, instagramAccountId: string): NormalizedInstagramWebhookEvent[] {
  if (!Array.isArray(entry.messaging)) {
    return [];
  }

  return entry.messaging.filter(isRecord).flatMap((messaging) => {
    const message = isRecord(messaging.message) ? messaging.message : undefined;
    const sender = isRecord(messaging.sender) ? messaging.sender : undefined;
    const senderId = stringValue(sender?.id);
    const sourceEventId = stringValue(message?.mid) ?? stringValue(messaging.mid);
    const text = stringValue(message?.text) ?? firstAttachmentText(message?.attachments) ?? '';

    if (!senderId || !sourceEventId || !text) {
      return [];
    }

    return [
      {
        kind: 'dm',
        instagramAccountId,
        senderId,
        sourceEventId,
        text,
        occurredAt: timestampValue(messaging.timestamp),
      },
    ];
  });
}

function normalizeCommentChanges(entry: Record<string, unknown>, instagramAccountId: string): NormalizedInstagramWebhookEvent[] {
  if (!Array.isArray(entry.changes)) {
    return [];
  }

  return entry.changes.filter(isRecord).flatMap((change) => {
    const field = stringValue(change.field);
    if (field && !['comments', 'comment', 'live_comments'].includes(field)) {
      return [];
    }

    const value = isRecord(change.value) ? change.value : undefined;
    const from = isRecord(value?.from) ? value.from : undefined;
    const media = isRecord(value?.media) ? value.media : undefined;
    const sourceEventId = stringValue(value?.id) ?? stringValue(value?.comment_id);
    const senderId = stringValue(from?.id) ?? stringValue(value?.from_id) ?? stringValue(value?.user_id);
    const text = stringValue(value?.text) ?? stringValue(value?.message) ?? '';

    if (!sourceEventId || !senderId || !text) {
      return [];
    }

    return [
      {
        kind: 'comment',
        instagramAccountId,
        senderId,
        senderName: stringValue(from?.username) ?? stringValue(from?.name),
        sourceEventId,
        text,
        mediaUrl: stringValue(value?.media_url),
        publication: {
          id: stringValue(value?.media_id) ?? stringValue(media?.id) ?? stringValue(value?.post_id),
          url: stringValue(value?.permalink) ?? stringValue(media?.permalink),
          caption: stringValue(media?.caption) ?? stringValue(value?.caption),
        },
        occurredAt: timestampValue(value?.created_time),
      },
    ];
  });
}

function routingPreconditionFailure(account: AxelorInstagramAccountRecord | null): string {
  if (!account) {
    return 'instagram_account_not_found';
  }

  if (account.chatwootIntegrationStatus && account.chatwootIntegrationStatus !== IntegrationStatus.Active) {
    return 'instagram_account_not_active';
  }

  if (!toPositiveIntegerOrNull(account.chatwootAccountId) || !toPositiveIntegerOrNull(account.chatwootInboxId)) {
    return 'instagram_account_chatwoot_linkage_missing';
  }

  if (!account.agent?.chatwootApiKey) {
    return 'missing_agent_chatwoot_api_key';
  }

  return 'instagram_account_not_routable';
}

function instagramScopePreconditionFailure(account: AxelorInstagramAccountRecord | null): string | null {
  if (!account || !hasInstagramScopeEvidence(account)) {
    return null;
  }

  const grantedScopes = readInstagramScopes(account);
  return REQUIRED_INSTAGRAM_SCOPES.every((scope) => grantedScopes.has(scope)) ? null : 'instagram_account_required_scopes_missing';
}

function hasInstagramScopeEvidence(account: AxelorInstagramAccountRecord): boolean {
  return ['scopes', 'instagramScopes', 'grantedScopes', 'granted_scopes'].some((field) => Object.prototype.hasOwnProperty.call(account, field));
}

function readInstagramScopes(account: AxelorInstagramAccountRecord): Set<string> {
  return new Set(
    [account.scopes, account.instagramScopes, account.grantedScopes, account.granted_scopes]
      .flatMap((value) => normalizeScopeEvidence(value))
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

function normalizeScopeEvidence(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(/[\s,]+/);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeScopeEvidence(item));
  }

  if (isRecord(value)) {
    return [value.name, value.scope, value.value].flatMap((item) => normalizeScopeEvidence(item));
  }

  return [];
}

function isRoutableInstagramAccount(account: AxelorInstagramAccountRecord | null): account is RoutableInstagramAccount {
  return (
    Boolean(account) &&
    (!account?.chatwootIntegrationStatus || account.chatwootIntegrationStatus === IntegrationStatus.Active) &&
    Boolean(toPositiveIntegerOrNull(account?.chatwootAccountId)) &&
    Boolean(toPositiveIntegerOrNull(account?.chatwootInboxId)) &&
    Boolean(account?.agent?.chatwootApiKey)
  );
}

function buildConversationAttributes(event: NormalizedInstagramWebhookEvent): Record<string, unknown> {
  return {
    instagram_event_kind: event.kind,
    instagram_account_id: event.instagramAccountId,
    instagram_sender_id: event.senderId,
    instagram_source_event_id: event.sourceEventId,
    ...(event.publication?.id ? { instagram_publication_id: event.publication.id } : {}),
    ...(event.publication?.url ? { instagram_publication_url: event.publication.url } : {}),
    ...(event.publication?.caption ? { instagram_publication_caption: event.publication.caption } : {}),
  };
}

function buildMessageAttributes(event: NormalizedInstagramWebhookEvent): Record<string, unknown> {
  return {
    instagram_event_kind: event.kind,
    instagram_source_event_id: event.sourceEventId,
    ...(event.mediaUrl ? { instagram_media_url: event.mediaUrl } : {}),
  };
}

function buildVisibleMessageContent(event: NormalizedInstagramWebhookEvent): string {
  if (event.kind !== 'comment') {
    return event.text;
  }

  const context = event.publication?.url ?? event.publication?.id;
  return context ? `Instagram comment on ${context}\n\n${event.text}` : `Instagram comment\n\n${event.text}`;
}

function toPositiveInteger(value: unknown, label: string): number {
  const result = toPositiveIntegerOrNull(value);
  if (!result) {
    throw new Error(`${label} is not a positive integer`);
  }
  return result;
}

function toPositiveIntegerOrNull(value: unknown): number | null {
  const numericValue = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof numericValue === 'number' && Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  return stringValue(value);
}

function firstAttachmentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachment = value.find(isRecord);
  const type = stringValue(attachment?.type);
  return type ? `[Instagram ${type}]` : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type RoutableInstagramAccount = AxelorInstagramAccountRecord & {
  agent: { chatwootApiKey: string };
};
