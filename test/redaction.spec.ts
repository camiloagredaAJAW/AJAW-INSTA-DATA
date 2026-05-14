import { redactHeaders, redactObject, redactText, redactValue } from '../src/shared/redaction';

describe('redaction utility', () => {
  it('masks sensitive object keys recursively', () => {
    const redacted = redactObject({
      username: 'agent',
      password: 'super-secret',
      nested: {
        api_access_token: 'cw-token',
        safe: 'visible',
      },
    });

    expect(redacted).toEqual({
      username: 'agent',
      password: '[REDACTED]',
      nested: {
        api_access_token: '[REDACTED]',
        safe: 'visible',
      },
    });
  });

  it('masks sensitive headers and cookie text without exposing raw values', () => {
    expect(
      redactHeaders({
        Authorization: 'Basic dXNlcjpwYXNz',
        Cookie: 'JSESSIONID=session-secret',
        Accept: 'application/json',
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      Accept: 'application/json',
    });

    const redacted = redactText('Authorization: Bearer chatwoot-secret; JSESSIONID=session-secret; password=raw-password; "hmac_token":"hmac-secret"');

    expect(redacted).not.toContain('chatwoot-secret');
    expect(redacted).not.toContain('session-secret');
    expect(redacted).not.toContain('raw-password');
    expect(redacted).not.toContain('hmac-secret');
    expect(redacted).toContain('[REDACTED]');
  });

  it('keeps only a small non-secret hint when explicitly redacting a value', () => {
    expect(redactValue('abcdefghijklmnopqrstuvwxyz')).toBe('ab…yz');
    expect(redactValue('key')).toBe('[REDACTED]');
  });
});
