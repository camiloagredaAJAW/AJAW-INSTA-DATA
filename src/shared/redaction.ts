const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|hmac[-_]?token|auth(?:orization)?|cookie|csrf|password|secret|session|jsessionid|tenantid)/i;

export type Redactable = string | number | boolean | null | undefined | Redactable[] | { [key: string]: Redactable };

export function redactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return REDACTED;
  }

  const text = String(value);
  if (text.length <= 4) {
    return REDACTED;
  }

  return `${text.slice(0, 2)}…${text.slice(-2)}`;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactObject<T extends Record<string, Redactable>>(input: T): T {
  const result: Record<string, Redactable> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = value.map((item) => (isPlainRecord(item) ? redactObject(item) : item));
      continue;
    }

    if (isPlainRecord(value)) {
      result[key] = redactObject(value);
      continue;
    }

    result[key] = value;
  }

  return result as T;
}

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveKey(key) && value !== undefined ? REDACTED : value;
  }

  return result;
}

export function redactText(input: string): string {
  return input
    .replace(/(authorization\s*[:=]\s*)(?:Basic|Bearer)?\s*[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(api[_-]?access[_-]?token\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/((?:JSESSIONID|TENANTID|CSRF-TOKEN)\s*=)\s*[^;\s]+/gi, `$1${REDACTED}`)
    .replace(/((?:password|secret|token|apiKey|api_key|hmac_token)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/("(?:hmac_token|api_access_token|token|password|secret)"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`);
}

function isPlainRecord(value: unknown): value is Record<string, Redactable> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
