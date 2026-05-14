import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentConfig } from '../config/environment';

export interface HealthResponse {
  status: 'ok';
  service: 'ajaw-insta-data';
  environment: EnvironmentConfig['NODE_ENV'];
}

@Injectable()
export class HealthService {
  constructor(private readonly configService: ConfigService<EnvironmentConfig, true>) {}

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'ajaw-insta-data',
      environment: this.configService.get('NODE_ENV', { infer: true }),
    };
  }
}
