# AJAW Instagram Data Middleware

NestJS + TypeScript backend foundation for the AJAWMRP, Chatwoot, and Instagram middleware described in `PRD.md`.

Current version: `0.1.0`.

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
- `META_APP_ID`
- `META_APP_SECRET`
- `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `INSTAGRAM_ACCESS_TOKEN`
- `LOG_LEVEL`

## Health

`GET /health` returns a non-secret readiness response for runtime smoke tests.

## Instagram activation API

`POST /integrations/instagram/activate` is an internal-only endpoint guarded by `x-internal-api-key`.

Request body:

```json
{ "agentId": 7 }
```

The activation use case logs in to AJAWMRP, resolves the Agent and its InstagramAccount, then reuses or creates a Chatwoot API Channel inbox. It prefers the published `InstagramAccount.chatwootAccountId` when it is a positive ID; it calls Chatwoot profile only as a fallback when that stored account ID is missing or invalid and `Agent.chatwootApiKey` is available.

AJAWMRP now publishes the required InstagramAccount Chatwoot linkage fields:

- `chatwootAccountId`, `chatwootInboxId`, `chatwootChannelId`, `chatwootChannelType`
- `chatwootInboxName`, `chatwootInboxIdentifier`, `chatwootWebhookUrl`, `chatwootHmacToken`
- `chatwootIntegrationStatus`, `chatwootLastSyncAt`, `chatwootLastIntegrationError`

When those fields are present in the returned InstagramAccount shape, activation persists `active` or `failed` lifecycle state. Linkage IDs must be positive; `0`, `null`, or missing `chatwootInboxId`/`chatwootChannelId` values are treated as not provisioned. If the shape lacks required fields, activation returns `schema_gap` and avoids unsafe writes.

After creating or reusing a Chatwoot inbox, the service reads `InstagramAccount` back from AJAWMRP and returns `active` only if persisted Chatwoot IDs/status match the expected values.

Chatwoot API Channel inboxes are named from the Instagram account display name and end with `IG`, for example `Chakana Geodesic Domes IG`. If another API inbox already uses that name, the service appends a numeric suffix like `Chakana Geodesic Domes IG 2`.

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

## Redaction behavior

Diagnostics and route responses must not expose API keys, access tokens, cookies, Basic auth values, HMAC tokens, passwords, sessions, or credential payload fragments.

## Rollout guard

Before enabling production n8n calls broadly, dry-run each new customer Agent in an internal environment and confirm AJAWMRP stores the Chatwoot IDs, inbox metadata, lifecycle status, and sync timestamp without duplicate Chatwoot inbox creation.
