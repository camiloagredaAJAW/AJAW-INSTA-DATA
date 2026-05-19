import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { ActivateInstagramIntegrationService } from './activateInstagramIntegration';
import { InstagramBusinessLoginService } from './instagramBusinessLogin';
import { InstagramWebhookRoutingService } from './instagramWebhookRouting';
import { InstagramOutboundMessagesService } from './instagramOutboundMessages';

@Module({
  imports: [InfrastructureModule],
  providers: [ActivateInstagramIntegrationService, InstagramBusinessLoginService, InstagramWebhookRoutingService, InstagramOutboundMessagesService],
  exports: [ActivateInstagramIntegrationService, InstagramBusinessLoginService, InstagramWebhookRoutingService, InstagramOutboundMessagesService],
})
export class ApplicationModule {}
