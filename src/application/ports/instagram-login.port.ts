export interface InstagramLoginStartRequest {
  agentId: string | number;
}

export interface InstagramLoginStartResult {
  authorizeUrl: string;
  state: string;
  instagramAccountId: string | number;
}

export interface InstagramCallbackRequest {
  code: string;
  state: string;
}

export interface InstagramCallbackResult {
  status: 'connected';
  instagramAccountId: string | number;
  instagramUserId: string;
  name?: string;
  username?: string;
  tokenSource: 'short_lived' | 'long_lived';
  longLivedTokenExchange?: InstagramLongLivedTokenExchangeMetadata;
}

export interface InstagramLongLivedTokenExchangeMetadata {
  attempted: boolean;
  succeeded: boolean;
  error?: SafeInstagramOAuthError;
}

export interface SafeInstagramOAuthError {
  status?: number;
  message: string;
}

export interface InstagramBusinessLoginUseCase {
  start(request: InstagramLoginStartRequest): Promise<InstagramLoginStartResult>;
  completeCallback(request: InstagramCallbackRequest): Promise<InstagramCallbackResult>;
}
