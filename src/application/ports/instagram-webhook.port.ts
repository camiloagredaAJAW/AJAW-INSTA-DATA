export type InstagramWebhookEventKind = 'dm' | 'comment';

export interface InstagramWebhookRouteRequest {
  payload: unknown;
}

export interface NormalizedInstagramWebhookEvent {
  kind: InstagramWebhookEventKind;
  instagramAccountId: string;
  direction: 'incoming' | 'outgoing';
  senderId: string;
  senderName?: string;
  sourceEventId: string;
  text: string;
  mediaUrl?: string;
  publication?: InstagramPublicationReference;
  occurredAt?: string;
}

export interface InstagramPublicationReference {
  id?: string;
  url?: string;
  caption?: string;
}

export interface InstagramWebhookRouteResult {
  status: 'processed' | 'ignored' | 'failed';
  processed: InstagramWebhookDeliveredEvent[];
  ignored: InstagramWebhookIgnoredEvent[];
  failures: InstagramWebhookFailure[];
}

export interface InstagramWebhookDeliveredEvent {
  kind: InstagramWebhookEventKind;
  sourceEventId: string;
  conversationSourceId: string;
  messageSourceId: string;
}

export interface InstagramWebhookIgnoredEvent {
  sourceEventId?: string;
  reason: string;
}

export interface InstagramWebhookFailure {
  sourceEventId?: string;
  classification: 'non_retriable' | 'retriable';
  reason: string;
}

export interface InstagramWebhookRoutingUseCase {
  route(request: InstagramWebhookRouteRequest): Promise<InstagramWebhookRouteResult>;
}
