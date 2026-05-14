import { Module } from '@nestjs/common';
import { DefaultAxelorClient } from './axelor/axelor.client';
import { DefaultChatwootClient } from './chatwoot/chatwoot.client';

@Module({
  providers: [DefaultAxelorClient, DefaultChatwootClient],
  exports: [DefaultAxelorClient, DefaultChatwootClient],
})
export class InfrastructureModule {}
