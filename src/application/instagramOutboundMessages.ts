import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AxelorInstagramAccountRecord, DefaultAxelorClient } from '../infrastructure/axelor/axelor.client';
import { ChatwootConversationSummary, ChatwootMessageSummary, DefaultChatwootClient } from '../infrastructure/chatwoot/chatwoot.client';
import { InstagramOAuthClient } from '../infrastructure/meta/instagram-oauth.client';
import { redactText } from '../shared/redaction';

export interface ChatwootMessageCreatedPayload {
  event?: string;
  id?: string | number;
  content?: string;
  content_attributes?: Record<string, unknown>;
  message_type?: string;
  private?: boolean;
  source_id?: string | null;
  inbox?: { id?: string | number };
  account?: { id?: string | number };
  contact?: { identifier?: string | null };
  conversation?: {
    id?: string | number;
    contact_inbox?: { source_id?: string | null };
    meta?: { sender?: { identifier?: string | null } };
  };
}

export interface OutboundMessageResult {
  status: 'sent' | 'ignored' | 'failed';
  reason?: string;
  messageId?: string;
}

export interface ChatwootWebhookSignatureInput {
  signature?: string;
  timestamp?: string;
  rawBody: Buffer;
}

@Injectable()
export class InstagramOutboundMessagesService {
  private readonly logger = new Logger(InstagramOutboundMessagesService.name);
  private readonly sentInstagramMessageIds = new Set<string>();
  private readonly recentOutboundFingerprints = new Map<string, number>();

  constructor(
    private readonly axelorClient: DefaultAxelorClient,
    private readonly chatwootClient: DefaultChatwootClient,
    private readonly instagramOAuthClient: InstagramOAuthClient,
  ) {}

  isRelevantOutboundWebhook(payload: ChatwootMessageCreatedPayload): boolean {
    return parseChatwootOutboundPayload(payload) !== null;
  }

  async isValidChatwootWebhookSignature(payload: ChatwootMessageCreatedPayload, input: ChatwootWebhookSignatureInput): Promise<boolean> {
    const linkage = parseChatwootWebhookLinkage(payload);
    if (!linkage || !input.timestamp || !input.signature?.startsWith('sha256=')) {
      return false;
    }

    const providedHex = input.signature.slice('sha256='.length);
    if (!/^[a-fA-F0-9]{64}$/.test(providedHex)) {
      return false;
    }

    await this.axelorClient.login();
    const account = await this.axelorClient.findInstagramAccountByChatwootLinkage(linkage.chatwootAccountId, linkage.chatwootInboxId);
    const secret = typeof account?.chatwootHmacToken === 'string' && account.chatwootHmacToken.trim() ? account.chatwootHmacToken.trim() : undefined;

    if (secret && isValidChatwootSignature(secret, input.timestamp, providedHex, input.rawBody)) {
      return true;
    }

    const refreshedSecret = await this.refreshChatwootChannelSecret(account, linkage.chatwootInboxId);
    if (refreshedSecret && isValidChatwootSignature(refreshedSecret, input.timestamp, providedHex, input.rawBody)) {
      return true;
    }

    if (!secret && !refreshedSecret) {
      this.logger.warn('Rejected Chatwoot webhook POST: missing Chatwoot channel secret');
      return false;
    }

    this.logger.warn('Rejected Chatwoot webhook POST: signature mismatch');
    return false;
  }

  async handleChatwootMessageCreated(payload: ChatwootMessageCreatedPayload): Promise<OutboundMessageResult> {
    const parsed = parseChatwootOutboundPayload(payload);
    if (!parsed) {
      return { status: 'ignored', reason: 'not_outbound_instagram_reply' };
    }

    await this.axelorClient.login();
    const account = await this.axelorClient.findInstagramAccountByChatwootLinkage(parsed.chatwootAccountId, parsed.chatwootInboxId);
    const reason = missingOutboundPrecondition(account);
    if (reason) {
      this.logger.warn(`Chatwoot outbound message not sent to Instagram: reason=${reason}`);
      return { status: 'failed', reason };
    }

    const routableAccount = account as AxelorInstagramAccountRecord & { instagramUserId: string; accessToken: string };

    try {
      const chatwootApiKey = routableAccount.agent?.chatwootApiKey ?? await this.fetchAgentChatwootApiKey(routableAccount.agent?.id);
      const sendableContent = await this.buildSendableContent(parsed, chatwootApiKey);
      const result = await this.instagramOAuthClient.sendTextMessage(routableAccount.instagramUserId, parsed.recipientId, sendableContent, routableAccount.accessToken);
      if (result.messageId) {
        this.sentInstagramMessageIds.add(result.messageId);
      }
      this.recentOutboundFingerprints.set(buildOutboundFingerprint(parsed.recipientId, sendableContent), Date.now());
      this.logger.log(`Chatwoot outbound message sent to Instagram: chatwootMessageId=${parsed.chatwootMessageId ?? 'unknown'} recipientId=${parsed.recipientId}`);
      return { status: 'sent', messageId: result.messageId };
    } catch (error) {
      const safeReason = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error(`Chatwoot outbound message failed: chatwootMessageId=${parsed.chatwootMessageId ?? 'unknown'} reason=${safeReason}`);
      return { status: 'failed', reason: safeReason };
    }
  }

  private async buildSendableContent(parsed: ParsedChatwootOutboundPayload, apiKey: string | undefined): Promise<string> {
    const quotedContent = extractInlineQuotedContent(parsed.payload) ?? await this.fetchQuotedContent(parsed, apiKey);
    return quotedContent ? formatQuotedReply(quotedContent, parsed.content) : parsed.content;
  }

  private async fetchQuotedContent(parsed: ParsedChatwootOutboundPayload, apiKey: string | undefined): Promise<string | undefined> {
    if (!apiKey || !parsed.replyToMessageId || !parsed.conversationId) {
      return undefined;
    }

    try {
      const messages = await this.chatwootClient.listConversationMessages(Number(parsed.chatwootAccountId), apiKey, parsed.conversationId);
      const quotedMessageContent = findMessageContent(messages, parsed.replyToMessageId);
      if (quotedMessageContent) {
        return quotedMessageContent;
      }

      const conversation = await this.chatwootClient.getConversation(Number(parsed.chatwootAccountId), apiKey, parsed.conversationId);
      return findMessageContent(conversation.messages ?? [], parsed.replyToMessageId) ?? buildConversationReplyContext(conversation, parsed);
    } catch (error) {
      this.logger.warn(`Chatwoot quoted message lookup skipped: chatwootMessageId=${parsed.chatwootMessageId ?? 'unknown'} reason=${redactText(error instanceof Error ? error.message : String(error))}`);
      return undefined;
    }
  }

  private async fetchAgentChatwootApiKey(agentId: string | number | undefined): Promise<string | undefined> {
    if (!agentId) {
      return undefined;
    }

    try {
      return nonEmptyString((await this.axelorClient.fetchAgent(agentId))?.chatwootApiKey);
    } catch (error) {
      this.logger.warn(`Chatwoot API key lookup skipped for outbound reply context: reason=${redactText(error instanceof Error ? error.message : String(error))}`);
      return undefined;
    }
  }

  wasSentByThisService(instagramMessageId: string): boolean {
    return this.sentInstagramMessageIds.has(instagramMessageId);
  }

  wasRecentlySentByThisService(recipientId: string, content: string): boolean {
    const fingerprint = buildOutboundFingerprint(recipientId, content);
    const sentAt = this.recentOutboundFingerprints.get(fingerprint);
    if (!sentAt) {
      return false;
    }

    if (Date.now() - sentAt > 5 * 60 * 1000) {
      this.recentOutboundFingerprints.delete(fingerprint);
      return false;
    }

    return true;
  }

  private async refreshChatwootChannelSecret(account: AxelorInstagramAccountRecord | null, chatwootInboxId: string | number): Promise<string | undefined> {
    const chatwootAccountId = positiveId(account?.chatwootAccountId);
    const apiAccessToken = nonEmptyString(account?.agent?.chatwootApiKey);
    if (!account || !chatwootAccountId || !apiAccessToken || typeof account.version !== 'number') {
      return undefined;
    }

    try {
      const inboxes = await this.chatwootClient.listInboxes(Number(chatwootAccountId), apiAccessToken);
      const inbox = inboxes.find((candidate) => String(candidate.id) === String(chatwootInboxId));
      const refreshedSecret = nonEmptyString(inbox?.secret);
      if (!refreshedSecret) {
        return undefined;
      }

      await this.axelorClient.updateInstagramAccount(account.id, account.version, { chatwootHmacToken: refreshedSecret });
      this.logger.log(`Refreshed Chatwoot channel secret for inboxId=${chatwootInboxId}`);
      return refreshedSecret;
    } catch (error) {
      this.logger.warn(`Unable to refresh Chatwoot channel secret: reason=${redactText(error instanceof Error ? error.message : String(error))}`);
      return undefined;
    }
  }
}

function buildOutboundFingerprint(recipientId: string, content: string): string {
  return `${recipientId}\n${content.trim()}`;
}

function isValidChatwootSignature(secret: string, timestamp: string, providedHex: string, rawBody: Buffer): boolean {
  const expectedHex = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function parseChatwootWebhookLinkage(payload: ChatwootMessageCreatedPayload): { chatwootAccountId: string | number; chatwootInboxId: string | number } | null {
  const chatwootAccountId = positiveId(payload.account?.id);
  const chatwootInboxId = positiveId(payload.inbox?.id);

  return chatwootAccountId && chatwootInboxId ? { chatwootAccountId, chatwootInboxId } : null;
}

function parseChatwootOutboundPayload(payload: ChatwootMessageCreatedPayload): ParsedChatwootOutboundPayload | null {
  if (payload.event !== 'message_created' || payload.message_type !== 'outgoing' || payload.private === true) {
    return null;
  }

  const content = nonEmptyString(payload.content);
  const chatwootAccountId = positiveId(payload.account?.id);
  const chatwootInboxId = positiveId(payload.inbox?.id);
  const recipientId = resolveInstagramRecipientId(payload);

  if (!content || !chatwootAccountId || !chatwootInboxId || !recipientId) {
    return null;
  }

  return {
    payload,
    chatwootMessageId: payload.id,
    chatwootAccountId,
    chatwootInboxId,
    conversationId: positiveNumber(payload.conversation?.id),
    replyToMessageId: positiveNumber(readNested(payload.content_attributes, ['in_reply_to', 'id']) ?? payload.content_attributes?.in_reply_to),
    recipientId,
    content,
  };
}

function resolveInstagramRecipientId(payload: ChatwootMessageCreatedPayload): string | undefined {
  const identifier = nonEmptyString(payload.contact?.identifier) ?? nonEmptyString(payload.conversation?.meta?.sender?.identifier);
  if (identifier?.startsWith('instagram:user:')) {
    return identifier.slice('instagram:user:'.length);
  }

  const sourceId = nonEmptyString(payload.conversation?.contact_inbox?.source_id);
  const match = sourceId?.match(/^ig:[^:]+:user:(.+)$/);
  return match?.[1];
}

function missingOutboundPrecondition(account: AxelorInstagramAccountRecord | null): string | null {
  if (!account) {
    return 'instagram_account_not_found_by_chatwoot_linkage';
  }
  if (!account.instagramUserId) {
    return 'missing_instagram_user_id';
  }
  if (!account.accessToken) {
    return 'missing_instagram_access_token';
  }
  return null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveId(value: unknown): string | number | undefined {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function extractInlineQuotedContent(payload: ChatwootMessageCreatedPayload): string | undefined {
  return nonEmptyString(readNested(payload.content_attributes, ['in_reply_to', 'content']))
    ?? nonEmptyString(readNested(payload.content_attributes, ['quoted_message', 'content']))
    ?? nonEmptyString(readNested(payload.content_attributes, ['reply_to', 'content']))
    ?? nonEmptyString(readNested(payload.content_attributes, ['parent_message', 'content']));
}

function readNested(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function findMessageContent(messages: ChatwootMessageSummary[], messageId: number): string | undefined {
  return nonEmptyString(messages.find((message) => message.id === messageId)?.content);
}

function buildConversationReplyContext(conversation: ChatwootConversationSummary, parsed: ParsedChatwootOutboundPayload): string | undefined {
  const externalId = nonEmptyString(readNested(parsed.payload.content_attributes, ['in_reply_to_external_id']));
  const publicationUrl = nonEmptyString(conversation.custom_attributes?.instagram_publication_url);
  const sourceEventId = nonEmptyString(conversation.custom_attributes?.instagram_source_event_id);

  if (externalId && sourceEventId && externalId !== `ig:event:${sourceEventId}`) {
    return undefined;
  }

  return publicationUrl ? `Instagram comment on ${publicationUrl}` : undefined;
}

function formatQuotedReply(quotedContent: string, replyContent: string): string {
  return `En respuesta a:\n${quotePlainText(quotedContent)}\n\n${replyContent}`;
}

function quotePlainText(content: string): string {
  return content.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedChatwootOutboundPayload {
  payload: ChatwootMessageCreatedPayload;
  chatwootMessageId?: string | number;
  chatwootAccountId: string | number;
  chatwootInboxId: string | number;
  conversationId?: number;
  replyToMessageId?: number;
  recipientId: string;
  content: string;
}
