import { Module } from '@nestjs/common';
import { DefaultAxelorClient } from './axelor/axelor.client';
import { DefaultChatwootClient } from './chatwoot/chatwoot.client';
import { InstagramOAuthClient } from './meta/instagram-oauth.client';

@Module({
  providers: [DefaultAxelorClient, DefaultChatwootClient, InstagramOAuthClient],
  exports: [DefaultAxelorClient, DefaultChatwootClient, InstagramOAuthClient],
})
export class InfrastructureModule {}
