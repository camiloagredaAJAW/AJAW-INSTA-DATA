import { IntegrationStatus } from '../../domain/integrationStatus';

export interface ActivationRequest {
  agentId: string | number;
}

export interface ActivationResult {
  status: IntegrationStatus;
  agentId: string | number;
  instagramAccountId?: string | number;
  chatwootAccountId?: string | number;
  chatwootInboxId?: string | number;
  chatwootChannelId?: string | number;
  missingFields?: string[];
  proposedModelPath?: string;
  reason?: string;
}

export interface ActivateInstagramIntegrationUseCase {
  execute(request: ActivationRequest): Promise<ActivationResult>;
}
