import { validateEnvironment } from '../src/config/environment';
import { applyTestEnvironment } from './test-env';

describe('environment validation', () => {
  it('accepts the required runtime variables', () => {
    applyTestEnvironment();

    const config = validateEnvironment(process.env);

    expect(config.NODE_ENV).toBe('test');
    expect(config.AXELOR_LOGIN_PATH).toBe('/login.jsp');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('rejects missing internal API key without echoing the secret value', () => {
    applyTestEnvironment();
    const config = { ...process.env, INTERNAL_API_KEY: undefined };

    expect(() => validateEnvironment(config)).toThrow('INTERNAL_API_KEY');
    expect(() => validateEnvironment(config)).not.toThrow('test-internal-key');
  });
});
