export function applyTestEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.AXELOR_BASE_URL = 'https://axelor.test';
  process.env.AXELOR_LOGIN_PATH = '/login.jsp';
  process.env.AXELOR_USERNAME = 'test-user';
  process.env.AXELOR_PASSWORD = 'test-password';
  process.env.CHATWOOT_BASE_URL = 'https://chatwoot.test';
  process.env.AJAW_NAMESPACE = 'com.ajawmrp3.apps.prospectingai.db';
  process.env.MODEL_NAME_AGENT = 'Agent';
  process.env.MODEL_NAME_INSTAGRAM_ACCOUNT = 'InstagramAccount';
  process.env.INTERNAL_API_KEY = 'test-internal-key';
  process.env.LOG_LEVEL = 'info';
}
