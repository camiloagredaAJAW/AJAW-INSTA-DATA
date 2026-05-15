import { validateEnvironment } from '../src/config/environment';
import { applyTestEnvironment } from './test-env';

describe('environment validation', () => {
  it('accepts the required runtime variables', () => {
    applyTestEnvironment();

    const config = validateEnvironment(process.env);

    expect(config.NODE_ENV).toBe('test');
    expect(config.AXELOR_LOGIN_PATH).toBe('/login.jsp');
    expect(config.META_APP_SECRET).toBe('test-meta-app-secret');
    expect(config.META_WEBHOOK_VERIFY_TOKEN).toBe('test-webhook-verify-token');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('rejects missing internal API key without echoing the secret value', () => {
    applyTestEnvironment();
    const config = { ...process.env, INTERNAL_API_KEY: undefined };

    expect(() => validateEnvironment(config)).toThrow('INTERNAL_API_KEY');
    expect(() => validateEnvironment(config)).not.toThrow('test-internal-key');
  });

  it('requires Meta webhook secrets in production without echoing secret values', () => {
    applyTestEnvironment();
    const config = {
      ...process.env,
      NODE_ENV: 'production',
      META_APP_SECRET: undefined,
      META_WEBHOOK_VERIFY_TOKEN: undefined,
    };

    expect(() => validateEnvironment(config)).toThrow('META_APP_SECRET');
    expect(() => validateEnvironment(config)).toThrow('META_WEBHOOK_VERIFY_TOKEN');
    expect(() => validateEnvironment(config)).not.toThrow('test-meta-app-secret');
    expect(() => validateEnvironment(config)).not.toThrow('test-webhook-verify-token');
  });
});
