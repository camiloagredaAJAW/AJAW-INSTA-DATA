import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { ActivateInstagramIntegrationService } from './activateInstagramIntegration';
import { InstagramBusinessLoginService } from './instagramBusinessLogin';
import { InstagramWebhookRoutingService } from './instagramWebhookRouting';

@Module({
  imports: [InfrastructureModule],
  providers: [ActivateInstagramIntegrationService, InstagramBusinessLoginService, InstagramWebhookRoutingService],
  exports: [ActivateInstagramIntegrationService, InstagramBusinessLoginService, InstagramWebhookRoutingService],
})
export class ApplicationModule {}
