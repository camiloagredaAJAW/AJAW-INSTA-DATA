import Joi from 'joi';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface EnvironmentConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  AXELOR_BASE_URL: string;
  AXELOR_LOGIN_PATH: string;
  AXELOR_USERNAME: string;
  AXELOR_PASSWORD: string;
  CHATWOOT_BASE_URL: string;
  CHATWOOT_MAIN_ACCOUNT_ID?: string;
  CHATWOOT_MAIN_API_ACCESS_TOKEN?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  INSTAGRAM_BUSINESS_ACCOUNT_ID?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  AJAW_NAMESPACE: string;
  MODEL_NAME_AGENT: string;
  MODEL_NAME_INSTAGRAM_ACCOUNT: string;
  INTERNAL_API_KEY: string;
  LOG_LEVEL: LogLevel;
}

const environmentSchema = Joi.object<EnvironmentConfig>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  AXELOR_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
  AXELOR_LOGIN_PATH: Joi.string().pattern(/^\//).default('/login.jsp'),
  AXELOR_USERNAME: Joi.string().min(1).required(),
  AXELOR_PASSWORD: Joi.string().min(1).required(),
  CHATWOOT_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
  CHATWOOT_MAIN_ACCOUNT_ID: Joi.string().allow('').optional(),
  CHATWOOT_MAIN_API_ACCESS_TOKEN: Joi.string().allow('').optional(),
  META_APP_ID: Joi.string().allow('').optional(),
  META_APP_SECRET: Joi.string().allow('').optional(),
  INSTAGRAM_BUSINESS_ACCOUNT_ID: Joi.string().allow('').optional(),
  INSTAGRAM_ACCESS_TOKEN: Joi.string().allow('').optional(),
  AJAW_NAMESPACE: Joi.string().min(1).required(),
  MODEL_NAME_AGENT: Joi.string().min(1).default('Agent'),
  MODEL_NAME_INSTAGRAM_ACCOUNT: Joi.string().min(1).required(),
  INTERNAL_API_KEY: Joi.string().min(1).required(),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
}).unknown(true);

export function validateEnvironment(config: Record<string, unknown>): EnvironmentConfig {
  const { error, value } = environmentSchema.validate(config, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    const details = error.details.map((detail) => detail.message).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return value;
}
