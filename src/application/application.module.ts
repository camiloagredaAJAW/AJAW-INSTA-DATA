import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { ActivateInstagramIntegrationService } from './activateInstagramIntegration';
import { InstagramWebhookRoutingService } from './instagramWebhookRouting';

@Module({
  imports: [InfrastructureModule],
  providers: [ActivateInstagramIntegrationService, InstagramWebhookRoutingService],
  exports: [ActivateInstagramIntegrationService, InstagramWebhookRoutingService],
})
export class ApplicationModule {}
