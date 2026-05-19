import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApplicationModule } from './application/application.module';
import { validateEnvironment } from './config/environment';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { InstagramWebhookController } from './http/routes/instagram-webhook.controller';
import { ChatwootWebhookController } from './http/routes/chatwoot-webhook.controller';
import { IntegrationsController } from './http/routes/integrations.controller';
import { InfrastructureModule } from './infrastructure/infrastructure.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    ApplicationModule,
    InfrastructureModule,
  ],
  controllers: [HealthController, IntegrationsController, InstagramWebhookController, ChatwootWebhookController],
  providers: [HealthService],
})
export class AppModule {}
