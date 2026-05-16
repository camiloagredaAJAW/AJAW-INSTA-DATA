# AJAW Instagram Data Middleware

NestJS + TypeScript backend foundation for the AJAWMRP, Chatwoot, and Instagram middleware described in `PRD.md`.

Current version: `1.0.0`.

## Runtime

- Backend stack: NestJS + TypeScript.
- Source: `src/`.
- Tests: Jest + `@nestjs/testing` + Supertest.

## Scripts

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run start:dev
```

## Environment

Copy `.env.example` to `.env` and fill environment-specific values. Do not commit real credentials.

Required for boot validation:

- `AXELOR_BASE_URL`
- `AXELOR_USERNAME`
- `AXELOR_PASSWORD`
- `CHATWOOT_BASE_URL`
- `AJAW_NAMESPACE`
- `MODEL_NAME_INSTAGRAM_ACCOUNT`
- `INTERNAL_API_KEY`

Optional foundation variables currently validated when present:

- `NODE_ENV`
- `PORT`
- `AXELOR_LOGIN_PATH`
- `CHATWOOT_MAIN_ACCOUNT_ID`
- `CHATWOOT_MAIN_API_ACCESS_TOKEN`
- `APP_BASE_URL`
- `META_APP_ID`
- `META_APP_SECRET`
- `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `INSTAGRAM_ACCESS_TOKEN`
- `INSTAGRAM_OAUTH_REDIRECT_URI`
- `INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE`
- `LOG_LEVEL`

Instagram webhook routing requires these Meta values in every environment where the callback is enabled:

- `META_APP_SECRET` — the Meta app secret used to validate `X-Hub-Signature-256` POST signatures.
- `META_WEBHOOK_VERIFY_TOKEN` — an operator-chosen token that must match the token entered in Meta Developers during webhook verification.

Instagram Business Login requires:

- `META_APP_ID` and `META_APP_SECRET` from the same Meta app configured for webhooks and login.
- `INSTAGRAM_OAUTH_REDIRECT_URI` set to the public webhook URL, for example `https://<public-host>/integrations/instagram/webhook`. If omitted, the app derives it from `APP_BASE_URL` plus `/integrations/instagram/webhook`.
- `INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE=false` by default. Set it to `true` only after confirming the Graph long-lived token exchange is available for the Meta app; short-lived token activation still succeeds if this optional exchange fails.

Do not commit real values. Keep production secrets in the deployment secret store, not in source control.

## Health

`GET /health` returns a non-secret readiness response for runtime smoke tests.

## Instagram activation API

`POST /integrations/instagram/activate` is an internal-only endpoint guarded by `x-internal-api-key`.

Request body:

```json
{ "agentId": 7 }
```

The activation use case logs in to AJAWMRP, resolves the Agent and its InstagramAccount, then reuses or creates a Chatwoot API Channel inbox. It prefers the published `InstagramAccount.chatwootAccountId` when it is a positive ID; it calls Chatwoot profile only as a fallback when that stored account ID is missing or invalid and `Agent.chatwootApiKey` is available.

## Instagram webhook setup in Meta Developers

Configure the webhook from <https://developers.facebook.com/> for the same app that owns the Instagram integration:

1. Add the **Webhooks** product to the Meta app.
2. Use the callback URL exposed by this service: `https://<public-host>/integrations/instagram/webhook`.
3. Enter the exact verify token stored in `META_WEBHOOK_VERIFY_TOKEN`; Meta calls the GET challenge flow and the service returns `hub.challenge` only when the token matches.
4. Keep `META_APP_SECRET` configured in the runtime environment before enabling POST delivery. Incoming webhook POST requests are rejected unless `X-Hub-Signature-256` validates against the raw request body.
5. Subscribe the Instagram object/events needed for messages and comments, and ensure the connected account has the required scopes: `instagram_business_basic`, `instagram_business_manage_messages`, and `instagram_manage_comments`.

The webhook router resolves the target `InstagramAccount` by `instagramUserId`, then uses its existing Chatwoot API Channel linkage (`chatwootAccountId`, `chatwootInboxId`, and `Agent.chatwootApiKey`) to create Chatwoot contacts, contact inboxes, conversations, and incoming messages. Instagram DMs are routed to normal Chatwoot conversations. Instagram comments become independent Chatwoot conversations; the original publication id or URL is preserved in Chatwoot `custom_attributes` and in the visible first message context.

Duplicate protection uses deterministic Chatwoot `source_id` values derived from Meta ids (`ig:dm:*`, `ig:comment:*`, and `ig:event:*`). Same-payload duplicates are suppressed before delivery, while repeated Meta deliveries rely on those stable source ids being reconciled by Chatwoot.

AJAWMRP now publishes the required InstagramAccount Chatwoot linkage fields:

- `chatwootAccountId`, `chatwootInboxId`, `chatwootChannelId`, `chatwootChannelType`
- `chatwootInboxName`, `chatwootInboxIdentifier`, `chatwootWebhookUrl`, `chatwootHmacToken`
- `chatwootIntegrationStatus`, `chatwootLastSyncAt`, `chatwootLastIntegrationError`

When those fields are present in the returned InstagramAccount shape, activation persists `active` or `failed` lifecycle state. Linkage IDs must be positive; `0`, `null`, or missing `chatwootInboxId`/`chatwootChannelId` values are treated as not provisioned. If the shape lacks required fields, activation returns `schema_gap` and avoids unsafe writes.

After creating or reusing a Chatwoot inbox, the service reads `InstagramAccount` back from AJAWMRP and returns `active` only if persisted Chatwoot IDs/status match the expected values.

Chatwoot API Channel inboxes are named from the Instagram account display name and end with `IG`, for example `Chakana Geodesic Domes IG`. If another API inbox already uses that name, the service appends a numeric suffix like `Chakana Geodesic Domes IG 2`.

## Instagram Business Login

`GET /integrations/instagram/login?agentId=...` starts the app-owned Instagram Business OAuth flow. It is an internal-only endpoint guarded by `x-internal-api-key`.

For manual Postman testing:

1. Send `GET https://<public-host>/integrations/instagram/login?agentId=<agent-id>` with `x-internal-api-key` set.
2. Disable automatic redirects in Postman so the `302 Location` header is visible.
3. Copy the `Location` URL into a browser and complete the Meta login flow there.

The same public URL, `/integrations/instagram/webhook`, handles all Meta callbacks:

- GET webhook verification with `hub.challenge` returns the challenge when `META_WEBHOOK_VERIFY_TOKEN` matches.
- GET OAuth callback with `code` and `state` completes Instagram Business Login when no `hub.challenge` is present.
- POST webhook events continue through signed webhook ingestion.

In Meta Developers, register the exact redirect URL in both the Business/Facebook Login settings and the Instagram Business Login settings. The redirect URL must match `INSTAGRAM_OAUTH_REDIRECT_URI` exactly.

The callback exchanges Meta's `code` for a short-lived Instagram token and stores the connection in AJAWMRP. Long-lived token exchange is optional, best-effort, and controlled by `INSTAGRAM_ENABLE_LONG_LIVED_TOKEN_EXCHANGE`; keep it disabled until the app has been validated against Meta's current token-exchange behavior.

Historical n8n workflow exports under `references/n8n/` contained operational secrets. Treat those values as compromised: rotate any credentials or tokens that appeared there, scrub references before sharing, and do not use n8n as the runtime owner for this login/callback flow anymore.

## Verified real activation

The first real activation was verified with `agentId=1`:

```json
{
  "status": "active",
  "agentId": 1,
  "instagramAccountId": 1,
  "chatwootAccountId": 49,
  "chatwootInboxId": 72,
  "chatwootChannelId": 46,
  "reason": null
}
```

Running the activation twice returned the same Chatwoot IDs, confirming idempotency.

## Verified Instagram Business Login

The app-owned Instagram Business Login flow was verified with `agentId=1` after registering the same redirect URL in both Meta Business/Facebook Login and Instagram Business Login settings:

```json
{
  "status": "connected",
  "instagramAccountId": 1,
  "instagramUserId": "35972463999033656",
  "tokenSource": "short_lived",
  "longLivedTokenExchange": {
    "attempted": false,
    "succeeded": false
  }
}
```

This is the v1.0.0 release baseline: Chatwoot API Channel provisioning, signed Instagram webhooks, inbound DM/comment routing, and in-app Instagram Business Login are implemented and verified.

## Redaction behavior

Diagnostics and route responses must not expose API keys, access tokens, cookies, Basic auth values, HMAC tokens, passwords, sessions, or credential payload fragments.

## Rollout guard

Before enabling production n8n calls broadly, dry-run each new customer Agent in an internal environment and confirm AJAWMRP stores the Chatwoot IDs, inbox metadata, lifecycle status, and sync timestamp without duplicate Chatwoot inbox creation.
