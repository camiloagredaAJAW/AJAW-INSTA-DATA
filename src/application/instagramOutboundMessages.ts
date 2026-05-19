import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AxelorInstagramAccountRecord, DefaultAxelorClient } from '../infrastructure/axelor/axelor.client';
import { DefaultChatwootClient } from '../infrastructure/chatwoot/chatwoot.client';
import { InstagramOAuthClient } from '../infrastructure/meta/instagram-oauth.client';
import { redactText } from '../shared/redaction';

export interface ChatwootMessageCreatedPayload {
  event?: string;
  id?: string | number;
  content?: string;
  message_type?: string;
  private?: boolean;
  source_id?: string | null;
  inbox?: { id?: string | number };
  account?: { id?: string | number };
  contact?: { identifier?: string | null };
  conversation?: {
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
      const result = await this.instagramOAuthClient.sendTextMessage(routableAccount.instagramUserId, parsed.recipientId, parsed.content, routableAccount.accessToken);
      if (result.messageId) {
        this.sentInstagramMessageIds.add(result.messageId);
      }
      this.logger.log(`Chatwoot outbound message sent to Instagram: chatwootMessageId=${parsed.chatwootMessageId ?? 'unknown'} recipientId=${parsed.recipientId}`);
      return { status: 'sent', messageId: result.messageId };
    } catch (error) {
      const safeReason = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error(`Chatwoot outbound message failed: chatwootMessageId=${parsed.chatwootMessageId ?? 'unknown'} reason=${safeReason}`);
      return { status: 'failed', reason: safeReason };
    }
  }

  wasSentByThisService(instagramMessageId: string): boolean {
    return this.sentInstagramMessageIds.has(instagramMessageId);
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
    chatwootMessageId: payload.id,
    chatwootAccountId,
    chatwootInboxId,
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

interface ParsedChatwootOutboundPayload {
  chatwootMessageId?: string | number;
  chatwootAccountId: string | number;
  chatwootInboxId: string | number;
  recipientId: string;
  content: string;
}
