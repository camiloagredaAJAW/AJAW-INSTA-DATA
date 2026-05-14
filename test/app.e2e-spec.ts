import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { applyTestEnvironment } from './test-env';

describe('App foundation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    applyTestEnvironment();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots and exposes a non-secret health response', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          status: 'ok',
          service: 'ajaw-insta-data',
          environment: 'test',
        });
        expect(JSON.stringify(body)).not.toContain('test-internal-key');
        expect(JSON.stringify(body)).not.toContain('test-password');
      });
  });
});
