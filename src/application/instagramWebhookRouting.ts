import { Injectable, Logger } from '@nestjs/common';
import { IntegrationStatus } from '../domain/integrationStatus';
import { AxelorInstagramAccountRecord, DefaultAxelorClient } from '../infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../infrastructure/chatwoot/chatwoot.client';
import { InstagramMediaReferenceResponse, InstagramMessagingUserProfileResponse, InstagramOAuthClient } from '../infrastructure/meta/instagram-oauth.client';
import { InstagramOutboundMessagesService } from './instagramOutboundMessages';
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
    private readonly instagramOAuthClient: InstagramOAuthClient,
    private readonly outboundMessages?: InstagramOutboundMessagesService,
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
        if (
          event.direction === 'outgoing' &&
          (this.outboundMessages?.wasSentByThisService(event.sourceEventId) ||
            (event.text && this.outboundMessages?.wasRecentlySentByThisService(event.senderId, event.text)))
        ) {
          ignored.push({ sourceEventId: event.sourceEventId, reason: 'echo_of_chatwoot_outbound' });
          continue;
        }

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
    const enrichedEvent = await this.enrichCommentPublication(event, account);
    const apiKey = account.agent.chatwootApiKey;
    const chatwootAccountId = toPositiveInteger(account.chatwootAccountId, 'chatwootAccountId');
    const chatwootInboxId = toPositiveInteger(account.chatwootInboxId, 'chatwootInboxId');
    const contactSourceId = buildContactSourceId(enrichedEvent.senderId);
    const contactInboxSourceId = buildContactInboxSourceId(enrichedEvent.instagramAccountId, enrichedEvent.senderId);
    const messageSourceId = buildMessageSourceId(enrichedEvent.sourceEventId);
    const senderProfile = enrichedEvent.kind === 'dm' ? await this.fetchSenderProfile(enrichedEvent, account) : {};

    const contact = await this.findOrCreateContact(chatwootAccountId, apiKey, chatwootInboxId, contactSourceId, enrichedEvent, senderProfile);
    const existingContactInbox = contact.contact_inboxes?.find((link) => link.inbox?.id === chatwootInboxId && link.source_id === contactInboxSourceId);
    const contactInbox = existingContactInbox
      ? { id: existingContactInbox.id, source_id: existingContactInbox.source_id }
      : await this.chatwootClient.createContactInbox(chatwootAccountId, apiKey, {
          contact_id: contact.id,
          inbox_id: chatwootInboxId,
          source_id: contactInboxSourceId,
        });
    const conversationSourceId = buildConversationSourceId(enrichedEvent, contactInboxSourceId);
    const conversation = await this.findOrCreateConversation(chatwootAccountId, apiKey, chatwootInboxId, contact.id, contactInbox.id, enrichedEvent, conversationSourceId);
    await this.chatwootClient.createIncomingMessage(chatwootAccountId, apiKey, conversation.id, {
      content: buildVisibleMessageContent(enrichedEvent),
      source_id: messageSourceId,
      message_type: enrichedEvent.direction,
      content_attributes: buildMessageAttributes(enrichedEvent),
    });

    return { kind: enrichedEvent.kind, sourceEventId: enrichedEvent.sourceEventId, conversationSourceId, messageSourceId };
  }

  private async enrichCommentPublication(event: NormalizedInstagramWebhookEvent, account: RoutableInstagramAccount): Promise<NormalizedInstagramWebhookEvent> {
    if (event.kind !== 'comment' || event.publication?.url || !event.publication?.id || !account.accessToken) {
      return event;
    }

    try {
      const media = await this.instagramOAuthClient.fetchMediaReference(event.publication.id, account.accessToken);
      return mergeMediaReference(event, media);
    } catch (error) {
      this.logger.warn(`Instagram publication lookup skipped: mediaId=${event.publication.id} reason=${redactText(error instanceof Error ? error.message : String(error))}`);
      return event;
    }
  }

  private async findOrCreateConversation(
    chatwootAccountId: number,
    apiKey: string,
    chatwootInboxId: number,
    contactId: number,
    contactInboxId: number | undefined,
    event: NormalizedInstagramWebhookEvent,
    conversationSourceId: string,
  ) {
    if (event.kind === 'dm') {
      const conversations = await this.chatwootClient.listContactConversations(chatwootAccountId, apiKey, contactId);
      const existingConversation = conversations.find((conversation) => conversation.inbox_id === chatwootInboxId && conversation.status !== 'resolved' && conversation.source_id === conversationSourceId);
      if (existingConversation) {
        return existingConversation;
      }
    }

    return this.chatwootClient.createConversation(chatwootAccountId, apiKey, {
      inbox_id: chatwootInboxId,
      contact_id: contactId,
      source_id: conversationSourceId,
      contact_inbox_id: contactInboxId,
      custom_attributes: buildConversationAttributes(event),
    });
  }

  private async fetchSenderProfile(event: NormalizedInstagramWebhookEvent, account: RoutableInstagramAccount): Promise<InstagramMessagingUserProfileResponse> {
    if (!account.accessToken) {
      return {};
    }

    try {
      return await this.instagramOAuthClient.fetchMessagingUserProfile(event.senderId, account.accessToken);
    } catch (error) {
      this.logger.warn(`Instagram sender profile lookup skipped: senderId=${event.senderId} reason=${redactText(error instanceof Error ? error.message : String(error))}`);
      return {};
    }
  }

  private async findOrCreateContact(
    chatwootAccountId: number,
    apiKey: string,
    chatwootInboxId: number,
    contactSourceId: string,
    event: NormalizedInstagramWebhookEvent,
    senderProfile: InstagramMessagingUserProfileResponse,
  ) {
    const contacts = await this.chatwootClient.searchContacts(chatwootAccountId, apiKey, contactSourceId);
    const existingContact = contacts.find((contact) => contact.identifier === contactSourceId);
    if (existingContact) {
      const profileName = bestInstagramContactName(event, senderProfile);
      if (profileName && existingContact.name !== profileName) {
        await this.chatwootClient.updateContact(chatwootAccountId, apiKey, existingContact.id, {
          name: profileName,
          avatar_url: senderProfile.profilePic,
          additional_attributes: buildContactAttributes(event, senderProfile),
        });
      }
      return existingContact;
    }

    return this.chatwootClient.createContact(chatwootAccountId, apiKey, {
      inbox_id: chatwootInboxId,
      identifier: contactSourceId,
      name: bestInstagramContactName(event, senderProfile) ?? `Instagram user ${event.senderId}`,
      avatar_url: senderProfile.profilePic,
      additional_attributes: buildContactAttributes(event, senderProfile),
    });
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

export function buildConversationSourceId(event: NormalizedInstagramWebhookEvent, contactInboxSourceId: string): string {
  return event.kind === 'comment' ? `ig:comment:${event.sourceEventId}` : contactInboxSourceId;
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
    const recipient = isRecord(messaging.recipient) ? messaging.recipient : undefined;
    const senderId = stringValue(sender?.id);
    const recipientId = stringValue(recipient?.id);
    const sourceEventId = stringValue(message?.mid) ?? stringValue(messaging.mid);
    const text = stringValue(message?.text) ?? firstAttachmentText(message?.attachments) ?? '';
    const isOutgoing = senderId === instagramAccountId || message?.is_echo === true;
    const contactUserId = isOutgoing ? recipientId : senderId;

    if (!contactUserId || !sourceEventId || !text) {
      return [];
    }

    return [
      {
        kind: 'dm',
        instagramAccountId,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        senderId: contactUserId,
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
        direction: 'incoming',
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

function bestInstagramContactName(event: NormalizedInstagramWebhookEvent, senderProfile: InstagramMessagingUserProfileResponse): string | undefined {
  return senderProfile.name ?? senderProfile.username ?? event.senderName;
}

function buildContactAttributes(event: NormalizedInstagramWebhookEvent, senderProfile: InstagramMessagingUserProfileResponse): Record<string, unknown> {
  return {
    instagram_sender_id: event.senderId,
    instagram_account_id: event.instagramAccountId,
    ...(senderProfile.username ? { instagram_username: senderProfile.username } : {}),
    ...(senderProfile.name ? { instagram_name: senderProfile.name } : {}),
  };
}

function buildMessageAttributes(event: NormalizedInstagramWebhookEvent): Record<string, unknown> {
  return {
    instagram_event_kind: event.kind,
    instagram_source_event_id: event.sourceEventId,
    ...(event.mediaUrl ? { instagram_media_url: event.mediaUrl } : {}),
    ...(event.publication?.url ? { instagram_publication_url: event.publication.url } : {}),
  };
}

function buildVisibleMessageContent(event: NormalizedInstagramWebhookEvent): string {
  if (event.kind !== 'comment') {
    return event.text;
  }

  const context = event.publication?.url ?? event.publication?.id;
  return context ? `Instagram comment on ${context}\n\n${event.text}` : `Instagram comment\n\n${event.text}`;
}

function mergeMediaReference(event: NormalizedInstagramWebhookEvent, media: InstagramMediaReferenceResponse): NormalizedInstagramWebhookEvent {
  return {
    ...event,
    mediaUrl: event.mediaUrl ?? media.mediaUrl,
    publication: {
      ...event.publication,
      id: event.publication?.id ?? media.id,
      url: event.publication?.url ?? media.permalink,
      caption: event.publication?.caption ?? media.caption,
    },
  };
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
