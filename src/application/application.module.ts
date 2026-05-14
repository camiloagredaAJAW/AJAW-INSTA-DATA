import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { ActivateInstagramIntegrationService } from './activateInstagramIntegration';

@Module({
  imports: [InfrastructureModule],
  providers: [ActivateInstagramIntegrationService],
  exports: [ActivateInstagramIntegrationService],
})
export class ApplicationModule {}
