# Proposal — Chatwoot fields for `InstagramAccount`

Esta propuesta agrega al modelo existente `InstagramAccount` los campos mínimos para que el middleware pueda crear o reutilizar un inbox `Channel::Api` de Chatwoot de forma idempotente.

## Campos propuestos

| Campo | Tipo | Motivo |
|---|---:|---|
| `chatwootAccountId` | integer | Cuenta Chatwoot resuelta desde `Agent.chatwootApiKey`. |
| `chatwootInboxId` | integer | ID principal del inbox creado/reutilizado. |
| `chatwootChannelId` | integer | ID del channel asociado al inbox. |
| `chatwootChannelType` | string | Debe ser `Channel::Api`; útil para validación. |
| `chatwootInboxName` | string | Nombre usado para búsqueda/idempotencia. |
| `chatwootInboxIdentifier` | string | Identificador devuelto por Chatwoot. |
| `chatwootWebhookUrl` | string large | Webhook URL del API Channel. |
| `chatwootHmacToken` | string large | Secreto opcional; persistir solo si se usará para validar callbacks. |
| `chatwootIntegrationStatus` | string | Estado: `pending`, `active`, `failed`, `schema_gap`. |
| `chatwootLastSyncAt` | datetime | Última sincronización/provisioning. |
| `chatwootLastIntegrationError` | string large | Último error accionable. |

## Recomendación

Agregar todos salvo que quieras evitar guardar `chatwootHmacToken`. Si no lo guardamos ahora, podemos agregarlo después cuando implementemos validación HMAC de callbacks.

## Gate

Cuando estos campos estén compilados y publicados en AJAWMRP, avisá “ya está arriba” antes de que los agentes hagan pruebas funcionales reales.
