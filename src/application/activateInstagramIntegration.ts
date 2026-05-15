import { Injectable } from '@nestjs/common';
import { IntegrationStatus } from '../domain/integrationStatus';
import { AxelorClient, AxelorInstagramAccountRecord, DefaultAxelorClient } from '../infrastructure/axelor/axelor.client';
import { ChatwootClient, ChatwootApiChannelSummary, ChatwootProfile, DefaultChatwootClient, isChatwootApiChannelInbox } from '../infrastructure/chatwoot/chatwoot.client';
import { redactText } from '../shared/redaction';
import { ActivationRequest, ActivationResult } from './ports/activation.port';

const REQUIRED_LINKAGE_FIELDS = [
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
] as const;

@Injectable()
export class ActivateInstagramIntegrationService {
  constructor(
    private readonly axelorClient: DefaultAxelorClient,
    private readonly chatwootClient: DefaultChatwootClient,
  ) {}

  async execute(request: ActivationRequest): Promise<ActivationResult> {
    const agentId = normalizeAgentId(request.agentId);

    await this.axelorClient.login();

    const agent = await this.axelorClient.fetchAgent(agentId);
    if (!agent) {
      return failed(agentId, 'agent_not_found');
    }

    const instagramAccount = (await this.axelorClient.searchInstagramAccountsByAgent(agentId, { limit: 1 }))[0];
    if (!instagramAccount) {
      return failed(agentId, 'instagram_account_not_found');
    }

    const existingLinkage = existingChatwootLinkage(instagramAccount);
    if (existingLinkage) {
      return {
        status: IntegrationStatus.Active,
        agentId,
        instagramAccountId: instagramAccount.id,
        chatwootAccountId: existingLinkage.chatwootAccountId,
        chatwootInboxId: existingLinkage.chatwootInboxId,
        chatwootChannelId: existingLinkage.chatwootChannelId,
      };
    }

    const missingFields = missingLinkageFields(instagramAccount);
    if (missingFields.length > 0) {
      return {
        status: IntegrationStatus.SchemaGap,
        agentId,
        instagramAccountId: instagramAccount.id,
        missingFields,
        proposedModelPath: 'references/ajawmrp/models/proposed/InstagramAccount.chatwoot-linkage.xml',
      };
    }

    if (typeof instagramAccount.version !== 'number') {
      return failed(agentId, 'instagram_account_version_missing');
    }

    try {
      if (!agent.chatwootApiKey) {
        const reason = 'missing_agent_chatwoot_api_key';
        await persistFailureSafely(this.axelorClient, instagramAccount.id, instagramAccount.version, reason);

        return failed(agentId, reason, instagramAccount.id);
      }

      const chatwootApiKey = agent.chatwootApiKey;
      const chatwootProfile = await this.chatwootClient.getProfile(chatwootApiKey);
      const chatwootAccountId = this.resolveChatwootAccountId(instagramAccount, chatwootProfile);

      const apiInboxes = (await this.chatwootClient.listInboxes(chatwootAccountId, chatwootApiKey)).filter(isChatwootApiChannelInbox);
      const inboxName = buildAvailableApiInboxName(resolveChatwootAccountName(chatwootProfile, chatwootAccountId), apiInboxes);
      const existingInbox = apiInboxes.find((inbox) => inbox.name === inboxName);
      const inbox = existingInbox ?? (await this.chatwootClient.createApiInbox(chatwootAccountId, chatwootApiKey, { name: inboxName }));

      const updatedInstagramAccount = await this.axelorClient.updateInstagramAccount(
        instagramAccount.id,
        instagramAccount.version,
        buildSuccessfulLinkageUpdate(chatwootAccountId, inbox),
      );
      const persistedInstagramAccount = await this.axelorClient.readInstagramAccount(instagramAccount.id);

      if (!isSuccessfulLinkagePersisted(persistedInstagramAccount, chatwootAccountId, inbox)) {
        const reason = 'instagram_account_persistence_failed';
        await persistFailureSafely(this.axelorClient, instagramAccount.id, persistedInstagramAccount?.version ?? updatedInstagramAccount.version ?? instagramAccount.version, reason);

        return failed(agentId, reason, instagramAccount.id);
      }

      return {
        status: IntegrationStatus.Active,
        agentId,
        instagramAccountId: instagramAccount.id,
        chatwootAccountId,
        chatwootInboxId: inbox.id,
        chatwootChannelId: inbox.channel_id,
      };
    } catch (error) {
      const reason = redactFailureReason(error, agent.chatwootApiKey ? [agent.chatwootApiKey] : []);
      await persistFailureSafely(this.axelorClient, instagramAccount.id, instagramAccount.version, reason);

      return failed(agentId, reason, instagramAccount.id);
    }
  }

  private resolveChatwootAccountId(instagramAccount: AxelorInstagramAccountRecord, profile: ChatwootProfile): number {
    const persistedAccountId = positiveIntegerId(instagramAccount.chatwootAccountId);
    if (persistedAccountId) {
      return persistedAccountId;
    }

    const profileAccountId = positiveIntegerId(profile.account_id);
    if (!profileAccountId) {
      throw new Error('Chatwoot profile response has invalid account_id');
    }

    return profileAccountId;
  }
}

export type { AxelorClient, ChatwootClient };

export function normalizeAgentId(agentId: string | number): string | number {
  if (typeof agentId === 'number') {
    if (!Number.isFinite(agentId) || agentId <= 0) {
      throw new Error('agentId must be a positive number or non-empty string');
    }

    return agentId;
  }

  if (typeof agentId === 'string' && agentId.trim().length > 0) {
    return agentId.trim();
  }

  throw new Error('agentId must be a positive number or non-empty string');
}

export function missingLinkageFields(instagramAccount: AxelorInstagramAccountRecord): string[] {
  return REQUIRED_LINKAGE_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(instagramAccount, field));
}

export function buildApiInboxName(accountName: string | undefined): string {
  const normalizedName = accountName?.trim();
  return `${normalizedName || 'Instagram Account'} IG`;
}

export function buildAvailableApiInboxName(accountName: string | undefined, existingInboxes: Array<Pick<ChatwootApiChannelSummary, 'name'>>): string {
  const baseName = buildApiInboxName(accountName);
  const existingNames = new Set(existingInboxes.map((inbox) => inbox.name));

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (existingNames.has(`${baseName} ${suffix}`)) {
    suffix += 1;
  }

  return `${baseName} ${suffix}`;
}

export function resolveChatwootAccountName(profile: ChatwootProfile, accountId: number): string | undefined {
  const matchingAccount = profile.accounts?.find((account) => account.id === accountId && account.name?.trim());
  if (matchingAccount?.name) {
    return matchingAccount.name;
  }

  return profile.accounts?.find((account) => account.name?.trim())?.name;
}

function existingChatwootLinkage(instagramAccount: AxelorInstagramAccountRecord): ExistingChatwootLinkage | null {
  const chatwootAccountId = positiveIntegerId(instagramAccount.chatwootAccountId);
  const chatwootInboxId = positiveIntegerId(instagramAccount.chatwootInboxId);
  const chatwootChannelId = positiveIntegerId(instagramAccount.chatwootChannelId);

  if (!chatwootAccountId || !chatwootInboxId) {
    return null;
  }

  return {
    chatwootAccountId,
    chatwootInboxId,
    ...(chatwootChannelId ? { chatwootChannelId } : {}),
  };
}

function positiveIntegerId(value: unknown): number | null {
  const numericValue = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;

  if (typeof numericValue !== 'number' || !Number.isInteger(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}

function failed(agentId: string | number, reason: string, instagramAccountId?: string | number): ActivationResult {
  return {
    status: IntegrationStatus.Failed,
    agentId,
    instagramAccountId,
    reason: redactText(reason),
  };
}

function isSuccessfulLinkagePersisted(
  instagramAccount: AxelorInstagramAccountRecord | null,
  accountId: number,
  inbox: ChatwootApiChannelSummary,
): boolean {
  if (!instagramAccount) {
    return false;
  }

  if (positiveIntegerId(instagramAccount.chatwootAccountId) !== accountId) {
    return false;
  }

  if (positiveIntegerId(instagramAccount.chatwootInboxId) !== inbox.id) {
    return false;
  }

  if (inbox.channel_id !== undefined && positiveIntegerId(instagramAccount.chatwootChannelId) !== inbox.channel_id) {
    return false;
  }

  return instagramAccount.chatwootIntegrationStatus === IntegrationStatus.Active;
}

function buildSuccessfulLinkageUpdate(accountId: number, inbox: ChatwootApiChannelSummary): Record<string, unknown> {
  return {
    chatwootAccountId: accountId,
    chatwootInboxId: inbox.id,
    chatwootChannelId: inbox.channel_id,
    chatwootChannelType: inbox.channel_type,
    chatwootInboxName: inbox.name,
    chatwootInboxIdentifier: inbox.inbox_identifier,
    chatwootWebhookUrl: inbox.webhook_url,
    ...(inbox.hmac_token ? { chatwootHmacToken: inbox.hmac_token } : {}),
    chatwootIntegrationStatus: IntegrationStatus.Active,
    chatwootLastSyncAt: new Date().toISOString(),
    chatwootLastIntegrationError: null,
  };
}

function buildFailedLinkageUpdate(reason: string): Record<string, unknown> {
  return {
    chatwootIntegrationStatus: IntegrationStatus.Failed,
    chatwootLastIntegrationError: reason,
    chatwootLastSyncAt: new Date().toISOString(),
  };
}

async function persistFailureSafely(axelorClient: DefaultAxelorClient, id: string | number, version: number, reason: string): Promise<void> {
  try {
    await axelorClient.updateInstagramAccount(id, version, buildFailedLinkageUpdate(reason));
  } catch {
    // The activation response remains deterministic even if the upstream failure-state write also fails.
  }
}

function redactFailureReason(error: unknown, knownSecrets: string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return knownSecrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), redactText(message));
}

interface ExistingChatwootLinkage {
  chatwootAccountId: string | number;
  chatwootInboxId: string | number;
  chatwootChannelId?: string | number;
}
