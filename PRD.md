# PRD — Backend intermedio para Instagram Inbox y Comentarios

Este producto será una API backend intermedia para centralizar la administración de mensajes de Instagram Inbox y comentarios de publicaciones. La solución actuará como puente entre Meta/Instagram, Chatwoot y una aplicación Axelor: Chatwoot será el front operativo del inbox mediante API Channel, mientras que Axelor/AJAWMRP manejará la configuración, persistencia y modelos de negocio desarrollados para este fin.

## 1. Resumen ejecutivo

| Tema | Decisión |
|------|----------|
| Producto | Middleware para reflejar conversaciones y comentarios de Instagram de clientes en Chatwoot. |
| Usuarios principales | Operadores internos, equipos de atención, marketing y administradores desde Axelor. |
| Sistemas consumidores | Aplicación basada en Axelor y API de Chatwoot. |
| Persistencia principal | Axelor, mediante modelos específicos consumidos por API. |
| Front operativo de inbox | Chatwoot vía API Channel por cuenta de cliente. |
| Rol de este proyecto | Integración, normalización, orquestación, seguridad y exposición de endpoints entre Meta, Chatwoot y Axelor. |
| Metodología | Spec-Driven Development, SDD, para planificar cambios antes de implementarlos. |

## 2. Problema

La gestión de interacciones de Instagram suele quedar fragmentada entre herramientas externas, acceso manual a Meta Business Suite y sistemas internos que no tienen una visión integrada del cliente o publicación.

Chatwoot solo permite conectar una cuenta de Instagram mediante su integración nativa por instalación, y esa integración ya está ocupada por la cuenta principal de la empresa. El negocio necesita ofrecer Instagram a múltiples clientes, igual que ya ofrece otros canales para agentes IA de ventas, usando API Channel como vía de integración.

El negocio necesita una capa middleware que permita reflejar mensajes y comentarios de Instagram de cada cliente en su propia cuenta/inbox de Chatwoot, y conservar configuración, tokens, trazabilidad y estado operativo en Axelor/AJAWMRP sin acoplar Chatwoot directamente a Meta/Instagram.

## 3. Objetivos

- Centralizar la comunicación con Instagram Graph API para mensajes Inbox y comentarios.
- Exponer endpoints claros para que Axelor consulte, sincronice y gestione interacciones.
- Integrarse con la API de Chatwoot para crear, actualizar y administrar conversaciones de inbox como front operativo.
- Crear automáticamente el API Channel/inbox de Chatwoot si no existe para la cuenta de Instagram del cliente.
- Exponer un webhook interno para que n8n active la integración enviando el `agentId` de AJAWMRP.
- Normalizar estructuras de datos provenientes de Instagram antes de enviarlas a Axelor.
- Mantener la persistencia fuera de este backend, delegándola en modelos Axelor.
- Preparar el proyecto para evolucionar con SDD: propuesta, especificación, diseño, tareas, implementación y verificación.

## 4. No objetivos iniciales

- No construir una interfaz de usuario propia.
- No reemplazar Axelor como sistema de persistencia o administración.
- No implementar un CRM completo dentro de este backend.
- No almacenar de forma permanente mensajes, comentarios o adjuntos salvo cachés técnicos estrictamente necesarios.
- No soportar otros canales, como WhatsApp, Facebook Messenger o TikTok, en la primera versión.

## 5. Usuarios y actores

| Actor | Necesidad |
|-------|-----------|
| Operador de atención | Ver, responder y dar seguimiento a mensajes Inbox desde Chatwoot. |
| Administrador | Configurar cuentas, permisos y estado de integración. |
| Axelor | Consumir endpoints del backend y persistir los datos en sus propios modelos. |
| Chatwoot | Proveer el front operativo de inbox y gestionar conversaciones con operadores. |
| Instagram/Meta | Proveedor externo de mensajes, comentarios, publicaciones, webhooks y APIs. |
| Backend intermedio | Traducir, validar, proteger y orquestar operaciones entre Meta, Chatwoot y Axelor. |

## 6. Alcance funcional inicial

### 6.1 Gestión de configuración de Instagram

- Registrar cuentas de Instagram Business conectadas.
- Administrar tokens, expiración y estado de conexión.
- Validar permisos requeridos de Meta.
- Exponer estado de salud de la integración para Axelor.

### 6.2 Sincronización de mensajes Inbox

- Recibir eventos por webhook cuando Instagram notifique nuevos mensajes.
- Consultar mensajes desde Instagram cuando Axelor solicite sincronización manual o incremental.
- Normalizar conversaciones, participantes, mensajes, timestamps y adjuntos.
- Crear o actualizar conversaciones y mensajes en Chatwoot para que los operadores gestionen el inbox.
- Enviar datos normalizados a los modelos Axelor correspondientes.

### 6.3 Gestión de respuestas a mensajes

- Permitir que Chatwoot solicite el envío de respuestas a conversaciones de Instagram.
- Sincronizar hacia Axelor el resultado y trazabilidad de las respuestas enviadas desde Chatwoot.
- Validar payloads antes de llamar a Meta.
- Registrar resultado de envío hacia Axelor: éxito, error recuperable o error definitivo.

### 6.4 Sincronización de comentarios de publicaciones

- Consultar publicaciones y comentarios asociados.
- Recibir eventos de nuevos comentarios cuando Meta lo permita mediante webhooks.
- Normalizar comentarios, autores, publicación origen, timestamps y estado.
- Enviar datos normalizados a Axelor.

### 6.5 Gestión de respuestas a comentarios

- Permitir responder comentarios desde Axelor.
- Permitir ocultar, mostrar o marcar comentarios según capacidades disponibles en Instagram Graph API.
- Reportar resultado operativo a Axelor.

### 6.6 Webhooks

- Exponer endpoint de verificación de webhook de Meta.
- Validar firma de eventos entrantes.
- Procesar eventos de forma idempotente.
- Reintentar operaciones fallidas cuando corresponda.

### 6.7 Activación desde n8n

- Exponer un endpoint interno protegido para recibir solicitudes desde n8n con `agentId`.
- Buscar el `Agent` en AJAWMRP y obtener su `chatwootApiKey`.
- Buscar la `InstagramAccount` asociada al `Agent`.
- Usar `InstagramAccount.chatwootAccountId` como cuenta Chatwoot preferida cuando sea un ID positivo; si falta o es inválido, resolver la `account_id` de Chatwoot usando el endpoint de perfil con `Agent.chatwootApiKey`.
- Crear el API Channel/inbox de Chatwoot si no existe.
- Persistir en `InstagramAccount` los identificadores necesarios de Chatwoot cuando el modelo lo permita.

## 7. Integración con Axelor

Axelor será el dueño de la persistencia funcional. Este backend no debe transformarse en una segunda fuente de verdad.

### Autenticación contra Axelor

La integración inicial contempla autenticación mediante endpoint `login.jsp` usando Basic Auth. El header `Authorization` no debe guardarse como valor estático: debe construirse a partir de `AXELOR_USERNAME` y `AXELOR_PASSWORD`, siguiendo la norma de uso de autenticación básica HTTP para REST API.

```bash
curl --location --request POST 'https://data.ajawmrp.com/login.jsp' \
  --header 'Authorization: Basic <base64(AXELOR_USERNAME:AXELOR_PASSWORD)>' \
  --data ''
```

| Campo | Valor |
|-------|-------|
| Método | `POST` |
| URL | `https://data.ajawmrp.com/login.jsp` |
| Auth | `Authorization: Basic base64(AXELOR_USERNAME:AXELOR_PASSWORD)` |
| Body | Vacío |
| Uso esperado | Obtener o inicializar sesión/autenticación para llamadas posteriores a modelos Axelor. |

Después del login, las siguientes peticiones a la REST API de AJAWMRP deben enviar:

- `Authorization: Basic base64(AXELOR_USERNAME:AXELOR_PASSWORD)`
- Cookie de sesión extraída de la respuesta del login, por ejemplo: `JSESSIONID=<value>; TENANTID=<value>`

> Nota: no debe commitearse una credencial real, token o cookie en documentación o código. La especificación SDD deberá definir cómo se inyectan estas credenciales por ambiente y cómo se renueva la cookie de sesión.

### Construcción de endpoints REST Axelor/AJAWMRP

Los endpoints REST de modelos AJAWMRP se construyen combinando el namespace configurado y el nombre del modelo.

Las referencias base para estas peticiones serán:

- REST estándar Axelor ADK 7.1: `https://docs.axelor.com/adk/7.1/dev-guide/web-services/rest.html`
- Servicios avanzados Axelor ADK 7.1: `https://docs.axelor.com/adk/7.1/dev-guide/web-services/advanced.html`

| Variable | Propósito |
|----------|-----------|
| `AJAW_NAMESPACE` | Namespace base de los modelos AJAWMRP. |
| `MODEL_NAME_INSTAGRAM_ACCOUNT` | Nombre del modelo de cuentas de Instagram. |

Ejemplo conceptual para `InstagramAccount`:

```text
ws/rest/{AJAW_NAMESPACE}.{MODEL_NAME_INSTAGRAM_ACCOUNT}
```

Ejemplo resultante:

```text
ws/rest/com.ajawmrp3.apps.prospectingai.db.InstagramAccount
```

### Operaciones REST estándar de Axelor

Según la documentación oficial de Axelor ADK 7.1, los servicios REST estándar siguen estos patrones:

| Operación | Método | Patrón |
|-----------|--------|--------|
| Buscar/listar registros | `GET` | `/ws/rest/:model?offset=0&limit=10` |
| Leer un registro | `GET` | `/ws/rest/:model/:id` |
| Crear un registro | `PUT` | `/ws/rest/:model` |
| Actualizar un registro | `POST` | `/ws/rest/:model/:id` |
| Eliminar un registro | `DELETE` | `/ws/rest/:model/:id` |

Para creación y actualización, el payload debe enviarse dentro de la propiedad `data`.

```json
{
  "data": {
    "fieldName": "value"
  }
}
```

Para actualización, Axelor requiere enviar el número de `version` del registro para evitar modificaciones conflictivas.

```json
{
  "data": {
    "id": 1,
    "version": 1,
    "fieldName": "new-value"
  }
}
```

Las respuestas exitosas usan `status: 0` y devuelven los registros dentro de `data`.

### Operaciones avanzadas de Axelor

Axelor también expone servicios avanzados para casos donde REST puro no alcanza.

| Operación | Método | Patrón | Uso esperado |
|-----------|--------|--------|--------------|
| Lectura parcial | `POST` | `/ws/rest/:model/:id/fetch` | Leer campos específicos y relaciones. |
| Eliminación masiva | `POST` | `/ws/rest/:model/removeAll` | Eliminar múltiples registros con `id` y `version`. |
| Búsqueda avanzada | `POST` | `/ws/rest/:model/search` | Buscar con `_domain`, `_domainContext` o `criteria`. |
| Ejecución de acciones | `POST` | `/ws/action` | Ejecutar acciones XML o métodos de controlador. |

La búsqueda avanzada será el patrón principal para consultar modelos con filtros dinámicos, como `InstagramAccount` por `instagramState`.

Ejemplo de filtro con `_domain`:

```json
{
  "offset": 0,
  "limit": 10,
  "fields": ["id", "instagramUserId", "active"],
  "sortBy": ["-id"],
  "data": {
    "_domain": "self.instagramState=:state",
    "_domainContext": {
      "state": "<instagram-state-id>"
    }
  }
}
```

La búsqueda avanzada también soporta `criteria` anidados con operadores como `and`, `or`, `not`, `=`, `!=`, `like`, `between`, `isNull` y `notNull`.

### Ejemplo de búsqueda de cuenta de Instagram

Para consultar la cuenta de Instagram asociada a un estado específico, el backend deberá ejecutar una petición `search` sobre el modelo `InstagramAccount`.

```bash
curl --location 'https://data.ajawmrp.com/ws/rest/com.ajawmrp3.apps.prospectingai.db.InstagramAccount/search' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Basic <base64(AXELOR_USERNAME:AXELOR_PASSWORD)>' \
  --header 'Cookie: JSESSIONID=<session-id>; TENANTID=<tenant-id>' \
  --data '{
    "limit": 1,
    "fields": [
      "id",
      "instagramUserId",
      "username",
      "accountType",
      "name",
      "profilePictureUrl",
      "accessToken",
      "refreshToken",
      "tokenExpiresAt",
      "active",
      "connectedAt",
      "agent"
    ],
    "sortBy": ["-id"],
    "data": {
      "_domain": "self.instagramState=:state",
      "_domainContext": {
        "state": "<instagram-state-id>"
      }
    }
  }'
```

Respuesta esperada, con secretos redactados:

```json
{
  "status": 0,
  "offset": 0,
  "total": 1,
  "data": [
    {
      "id": 1,
      "instagramUserId": "<instagram-user-id>",
      "username": null,
      "accountType": null,
      "name": null,
      "profilePictureUrl": null,
      "accessToken": "<instagram-access-token>",
      "refreshToken": null,
      "tokenExpiresAt": "2026-07-11T15:55:23.790Z",
      "active": false,
      "connectedAt": "2026-05-12T15:55:23.793Z",
      "agent": {
        "id": 1,
        "name": "Sophie",
        "$version": 93
      },
      "version": 12,
      "$wkfStatus": null
    }
  ]
}
```

El backend debe tratar `accessToken` y `refreshToken` como secretos: pueden ser consultados desde Axelor para operar contra Meta/Instagram, pero no deben imprimirse en logs ni exponerse en respuestas internas que no los necesiten.

### Campos de integración Chatwoot en InstagramAccount

Los datos de vínculo entre Instagram y Chatwoot deberán agregarse al modelo existente `InstagramAccount`, no a un modelo separado, salvo que una necesidad futura lo justifique.

Campos esperados publicados por AJAWMRP:

- `chatwootAccountId`
- `chatwootInboxId`
- `chatwootChannelId`, si Chatwoot lo devuelve separado del inbox
- `chatwootChannelType`
- `chatwootInboxName`
- `chatwootInboxIdentifier`
- `chatwootWebhookUrl`
- `chatwootHmacToken`
- `chatwootIntegrationStatus`
- `chatwootLastSyncAt`
- `chatwootLastIntegrationError`

Los IDs de vínculo deben ser positivos. Valores `0`, `null` o ausentes en `chatwootInboxId`/`chatwootChannelId` se consideran no provisionados, no un vínculo reusable.

Si estos campos no existen en AJAWMRP, los agentes deberán proponer el cambio XML en `references/ajawmrp/models/proposed/` y esperar confirmación humana de que el modelo fue compilado, publicado y está disponible antes de ejecutar pruebas funcionales contra AJAWMRP real.

### Responsabilidades de Axelor

- Persistir cuentas, publicaciones, conversaciones, mensajes, comentarios y estados operativos.
- Administrar usuarios internos y permisos de operación.
- Proveer modelos y endpoints específicos para que este backend cree o actualice información.
- Mostrar la información en sus vistas administrativas.

## 8. Integración con Chatwoot

Chatwoot será el front operativo para el inbox. El backend deberá integrarse con su API Channel para reflejar conversaciones provenientes de Instagram y recibir acciones realizadas por operadores.

### Responsabilidades de Chatwoot

- Mostrar conversaciones de Instagram Inbox a los operadores.
- Permitir responder mensajes desde su interfaz.
- Administrar asignaciones, estados y operación diaria del inbox según capacidades de Chatwoot.
- Mantener cuentas separadas por cliente: cada `chatwootAccount` tiene sus propios inboxes/channels.

### Resolución de cuenta Chatwoot desde Agent

El modelo `Agent` de AJAWMRP contiene el campo `chatwootApiKey`, que corresponde al `api_access_token` de Chatwoot. La `InstagramAccount` publicada por AJAWMRP contiene `chatwootAccountId`; cuando ese valor existe y es positivo, el backend debe usarlo como cuenta Chatwoot del cliente/agente sin consultar perfil. Con `chatwootApiKey`, el backend consulta perfil solo como fallback cuando `chatwootAccountId` falta o es inválido.

```bash
curl --location 'https://chat.ajaw.ai/api/v1/profile/' \
  --header 'api_access_token: <Agent.chatwootApiKey>' \
  --data ''
```

De la respuesta fallback se debe usar principalmente:

- `account_id`: cuenta Chatwoot donde crear o reutilizar el API Channel/inbox.
- `id`, `name`, `email` y `role`: datos útiles para auditoría o diagnóstico.

`chatwootApiKey` y `access_token` son secretos y no deben imprimirse en logs ni exponerse en respuestas del middleware.

### Responsabilidades del backend intermedio con Chatwoot

- Crear o actualizar contactos, conversaciones y mensajes en Chatwoot a partir de eventos de Instagram.
- Crear automáticamente un API Channel/inbox en la cuenta Chatwoot del cliente si no existe para esa `InstagramAccount`.
- Reutilizar el API Channel/inbox existente si ya está vinculado a la `InstagramAccount`.
- Recibir o consultar mensajes salientes generados en Chatwoot.
- Enviar esos mensajes salientes a Instagram mediante Meta Graph API.
- Sincronizar estado operativo y trazabilidad hacia Axelor cuando corresponda.
- Evitar duplicados entre eventos de Instagram, reintentos del backend y objetos creados en Chatwoot.

### Responsabilidades del backend intermedio

- Comunicarse con Meta/Instagram.
- Validar autenticación y autorización de llamadas entrantes desde Axelor.
- Transformar datos externos en contratos internos estables.
- Manejar errores, límites de API, reintentos e idempotencia.
- Exponer endpoints documentados para operaciones de Axelor.

## 9. Requisitos no funcionales

| Categoría | Requisito |
|-----------|-----------|
| Seguridad | Validar firmas de webhooks, proteger tokens y autenticar llamadas de Axelor. |
| Idempotencia | Evitar duplicados ante reintentos de Meta o Axelor. |
| Observabilidad | Registrar trazas, errores, latencias y correlación por evento o solicitud. |
| Resiliencia | Manejar rate limits, timeouts y errores temporales de Meta/Axelor. |
| Escalabilidad | Procesar eventos asincrónicamente cuando el volumen lo requiera. |
| Mantenibilidad | Contratos claros, capas separadas y documentación mediante SDD. |
| Auditoría | Reportar a Axelor el estado de operaciones críticas. |

## 10. Contratos API esperados

Los nombres son tentativos y deberán formalizarse en la especificación SDD.

| Endpoint | Consumidor | Propósito |
|----------|------------|-----------|
| `GET /health` | Axelor/infra | Verificar disponibilidad del servicio. |
| `POST /integrations/instagram/activate` | n8n | Activar/provisionar la integración para un `agentId`. |
| `GET /instagram/accounts/:id/status` | Axelor | Consultar estado de conexión de una cuenta. |
| `POST /instagram/webhooks` | Meta | Recibir eventos de Instagram. |
| `GET /instagram/webhooks` | Meta | Verificar configuración del webhook. |
| `POST /instagram/inbox/sync` | Axelor | Ejecutar sincronización de mensajes. |
| `POST /instagram/inbox/reply` | Chatwoot/Axelor | Enviar respuesta a una conversación. |
| `POST /instagram/comments/sync` | Axelor | Ejecutar sincronización de comentarios. |
| `POST /instagram/comments/reply` | Axelor | Responder un comentario. |
| `POST /instagram/comments/moderate` | Axelor | Ocultar, mostrar o moderar comentarios según soporte de API. |
| `POST /chatwoot/webhooks` | Chatwoot | Recibir eventos de mensajes salientes o cambios operativos del inbox. |
| `POST /chatwoot/conversations/sync` | Backend/Axelor | Sincronizar estado de conversaciones con Chatwoot. |

## 11. Modelo conceptual de datos

La persistencia real vivirá en Axelor, pero el backend deberá operar con estos conceptos mínimos:

- Cuenta de Instagram conectada.
- Publicación de Instagram.
- Conversación Inbox.
- Participante de conversación.
- Mensaje.
- Comentario.
- Adjunto o media.
- Evento de webhook.
- Resultado de operación.
- Conversación Chatwoot.
- Contacto Chatwoot.
- Mensaje saliente Chatwoot.
- API Channel/inbox Chatwoot.
- Agent AJAWMRP con `chatwootApiKey`.

## 12. Flujo de activación de integración

1. n8n llama al middleware enviando `agentId`.
2. El middleware valida `INTERNAL_API_KEY`.
3. El middleware inicia sesión contra AJAWMRP y obtiene cookie `JSESSIONID`/`TENANTID`.
4. El middleware busca el `Agent` por `agentId`.
5. El middleware lee `Agent.chatwootApiKey`.
6. El middleware busca la `InstagramAccount` asociada al `Agent`.
7. El middleware usa `InstagramAccount.chatwootAccountId` si es positivo; si falta o es inválido, consulta `GET /api/v1/profile` en Chatwoot con `api_access_token`.
8. El middleware obtiene `account_id` desde el valor persistido o desde el fallback de perfil.
9. El middleware verifica si `InstagramAccount` ya tiene `chatwootInboxId`/`chatwootChannelId` vigente y positivo.
10. Si no existe, crea el API Channel/inbox en esa cuenta Chatwoot.
11. El middleware actualiza `InstagramAccount` con los identificadores y estado de integración si los campos están disponibles.
12. El middleware responde a n8n con estado de éxito, datos de integración no sensibles y errores accionables si falla.

## 13. Flujo principal esperado

1. Meta envía un webhook por nuevo mensaje o comentario.
2. El backend valida firma, cuenta y tipo de evento.
3. El backend consulta datos adicionales en Instagram si el evento viene incompleto.
4. El backend normaliza el payload.
5. Para mensajes Inbox, el backend crea o actualiza la conversación en Chatwoot.
6. El backend llama a Axelor para crear o actualizar los modelos correspondientes.
7. Axelor persiste la información y mantiene la trazabilidad de negocio.
8. El operador responde desde Chatwoot.
9. Chatwoot notifica o expone el mensaje saliente al backend.
10. El backend valida la operación y la ejecuta contra Instagram.
11. El backend informa el resultado a Axelor y, si aplica, actualiza estado en Chatwoot.

## 14. Riesgos y dependencias

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Cambios o restricciones de Instagram Graph API | Alto | Diseñar adaptadores aislados y revisar permisos temprano. |
| Rate limits de Meta | Alto | Implementar colas, backoff y reintentos controlados. |
| Duplicación de eventos webhook | Medio | Usar claves idempotentes por evento/mensaje/comentario. |
| Contratos Axelor inestables | Alto | Definir contratos SDD antes de implementar. |
| Tokens expirados o permisos insuficientes | Alto | Health checks y estados claros para Axelor. |
| Persistencia distribuida accidental | Medio | Mantener Axelor como fuente de verdad. |
| Desalineación entre Chatwoot y Axelor | Alto | Definir ownership claro: Chatwoot opera inbox, Axelor persiste negocio. |
| Duplicados entre Meta y Chatwoot | Alto | Correlación por IDs externos e idempotencia por mensaje/conversación. |
| API Channel creado múltiples veces | Medio | Provisioning idempotente basado en `InstagramAccount` y campos Chatwoot persistidos. |
| Modelo AJAWMRP incompleto | Alto | Proponer XML, esperar publicación manual y recién después probar contra AJAWMRP real. |

## 15. Métricas de éxito

- Porcentaje de webhooks procesados exitosamente.
- Tiempo promedio entre evento recibido y persistencia en Axelor.
- Tasa de errores por llamadas a Meta.
- Tasa de errores por llamadas a Axelor.
- Cantidad de duplicados evitados por idempotencia.
- Tiempo promedio de respuesta de operadores desde Chatwoot.
- Porcentaje de conversaciones de Instagram correctamente reflejadas en Chatwoot.
- Porcentaje de activaciones n8n completadas sin intervención manual.

## 16. Criterios de aceptación de MVP

- [ ] El backend puede validar webhooks de Meta.
- [ ] El backend puede recibir eventos de mensajes Inbox.
- [ ] El backend puede crear o actualizar conversaciones de Instagram en Chatwoot.
- [ ] n8n puede activar la integración enviando `agentId`.
- [ ] El backend puede usar `InstagramAccount.chatwootAccountId` como cuenta preferida y obtener `account_id` desde Chatwoot solo como fallback.
- [ ] El backend puede crear automáticamente un API Channel/inbox si no existe.
- [ ] El backend reutiliza un API Channel/inbox existente para evitar duplicados.
- [ ] El backend puede procesar respuestas enviadas desde Chatwoot hacia Instagram.
- [ ] El backend puede recibir o sincronizar comentarios de publicaciones.
- [ ] El backend puede enviar datos normalizados a Axelor.
- [ ] Axelor es la fuente de verdad para persistencia funcional.
- [ ] El backend puede enviar respuestas a mensajes desde solicitudes de Axelor.
- [ ] El backend puede responder comentarios desde solicitudes de Axelor.
- [ ] Las operaciones críticas son idempotentes.
- [ ] Los errores relevantes se informan a Axelor con detalle accionable.
- [ ] Existen artefactos SDD para los cambios principales del proyecto.

## 17. Estrategia SDD del proyecto

Este proyecto deberá implementarse usando Spec-Driven Development. Cada cambio relevante debe pasar por artefactos explícitos antes de tocar código.

### Flujo SDD recomendado

1. **Exploración**: investigar restricciones de Instagram, Axelor y arquitectura actual.
2. **Propuesta**: definir intención, alcance y exclusiones del cambio.
3. **Spec**: documentar requisitos y escenarios verificables.
4. **Diseño**: decidir arquitectura, contratos, errores, seguridad y límites.
5. **Tasks**: dividir implementación en unidades revisables.
6. **Apply**: implementar siguiendo las tareas.
7. **Verify**: validar contra spec, diseño y pruebas.
8. **Archive**: cerrar el cambio y persistir aprendizajes.

### Cambios SDD iniciales sugeridos

- `instagram-webhook-ingestion`: verificación, firma, recepción e idempotencia de webhooks.
- `axelor-contracts`: contratos de integración entre backend y modelos Axelor.
- `chatwoot-api-channel-provisioning`: activación desde n8n, resolución de Agent/InstagramAccount y creación idempotente de API Channel/inbox.
- `chatwoot-inbox-integration`: creación, actualización y sincronización de conversaciones Inbox con Chatwoot.
- `inbox-message-sync`: sincronización y normalización de conversaciones y mensajes.
- `instagram-reply-flow`: envío de respuestas a mensajes desde Axelor.
- `comments-sync-and-moderation`: sincronización, respuesta y moderación de comentarios.
- `observability-and-error-reporting`: trazabilidad, errores y reportes operativos hacia Axelor.

## 18. Preguntas abiertas

- ¿Qué stack técnico usará el backend?
- ¿Qué versión de Chatwoot se usará y qué endpoints/webhooks estarán disponibles?
- ¿Qué modelo de autenticación usará Chatwoot para notificar mensajes salientes al backend?
- ¿Se requiere procesamiento asincrónico desde el inicio?
- ¿Qué operaciones de moderación de comentarios son obligatorias para negocio?
- ¿Quién administrará el ciclo de vida de tokens de Meta?
- ¿Los campos Chatwoot ya existen en `InstagramAccount` o deben proponerse en XML?

## 19. Próximo paso

El primer cambio formal `chatwoot-api-channel-provisioning` ya fue implementado y verificado con pruebas reales para `agentId=1`.

## 20. Estado de implementación

### `chatwoot-api-channel-provisioning`

| Tema | Estado |
|------|--------|
| Stack backend | NestJS + TypeScript implementado. |
| Activación n8n | `POST /integrations/instagram/activate` implementado. |
| Autenticación interna | Protegida con `INTERNAL_API_KEY`. |
| AJAWMRP | Login real, búsqueda de `Agent`, búsqueda/lectura/update de `InstagramAccount` verificados. |
| Chatwoot | Profile, list inboxes y create API inbox con `channel.type = "api"` verificados. |
| Idempotencia | Reutiliza linkage persistido, trata IDs `0` como no vinculados y evita duplicar inboxes. |
| Persistencia | Usa campos `chatwoot*` publicados en `InstagramAccount` y valida read-back antes de devolver `active`. |
| Seguridad | Redacción de tokens, cookies, Basic Auth, HMAC y secretos sensibles. |
| Verificación | `npm test`, `build`, `typecheck`, `lint` y activación real pasan. |

### Resultado SDD Verify

Veredicto: **PASS**.

Evidencia:

- `npm test` ✅ — 6 suites / 43 tests.
- `npm run build` ✅.
- `npm run typecheck` ✅.
- `npm run lint` ✅.
- Activación real con `agentId=1` ✅.
- Idempotencia real ✅: dos activaciones devolvieron los mismos IDs.
- Persistencia real en AJAWMRP ✅: el servicio devuelve `active` solo después de read-back exitoso.

Resultado real sanitizado:

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

### Próximo paso operativo

Archivar el cambio SDD y continuar con el próximo cambio funcional: sincronización de mensajes/comentarios de Instagram hacia Chatwoot.
