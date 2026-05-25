import { BadRequestException, Body, Controller, Get, Headers, Logger, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ActivateInstagramIntegrationService } from '../../application/activateInstagramIntegration';
import { InstagramBusinessLoginError, InstagramBusinessLoginService } from '../../application/instagramBusinessLogin';
import { EnvironmentConfig } from '../../config/environment';

interface ActivateInstagramDto {
  agentId?: string | number;
}

@Controller('integrations/instagram')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    private readonly activateInstagramIntegration: ActivateInstagramIntegrationService,
    private readonly instagramBusinessLogin: InstagramBusinessLoginService,
  ) {}

  @Get('login')
  async login(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query('agentId') agentId: string | undefined,
    @Query('response') responseMode: string | undefined,
    @Query('mode') mode: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    this.assertInternalApiKey(headers['x-internal-api-key'] ?? headers['internal-api-key']);

    if (!agentId || agentId.trim() === '') {
      throw new BadRequestException('agentId is required');
    }

    try {
      this.logger.log(`Instagram login start requested: agentId=${agentId}`);
      const result = await this.instagramBusinessLogin.start({ agentId });
      if (isJsonLoginResponseRequested(responseMode, mode)) {
        this.logger.log(`Instagram login authorization URL generated: agentId=${agentId} instagramAccountId=${result.instagramAccountId}`);
        response.status(200).json({
          authorizationUrl: result.authorizeUrl,
          state: result.state,
          agentId,
          instagramAccountId: result.instagramAccountId,
        });
        return;
      }

      this.logger.log(`Instagram login redirect generated: agentId=${agentId} instagramAccountId=${result.instagramAccountId}`);
      response.redirect(result.authorizeUrl);
    } catch (error) {
      if (error instanceof InstagramBusinessLoginError || (error instanceof Error && error.message.includes('agentId'))) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }

  @Post('activate')
  async activate(@Headers() headers: Record<string, string | string[] | undefined>, @Body() body: ActivateInstagramDto) {
    this.assertInternalApiKey(headers['x-internal-api-key'] ?? headers['internal-api-key']);

    if (!body || body.agentId === undefined || body.agentId === null || (typeof body.agentId === 'string' && body.agentId.trim() === '')) {
      throw new BadRequestException('agentId is required');
    }

    try {
      return await this.activateInstagramIntegration.execute({ agentId: body.agentId });
    } catch (error) {
      if (error instanceof Error && error.message.includes('agentId')) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }

  private assertInternalApiKey(actualHeader: string | string[] | undefined): void {
    const actual = Array.isArray(actualHeader) ? actualHeader[0] : actualHeader;
    const expected = this.configService.get('INTERNAL_API_KEY', { infer: true }) ?? process.env.INTERNAL_API_KEY;
    if (!actual || actual !== expected) {
      throw new UnauthorizedException('Invalid internal API key');
    }
  }
}

function isJsonLoginResponseRequested(responseMode: string | undefined, mode: string | undefined): boolean {
  return [responseMode, mode].some((value) => typeof value === 'string' && value.trim().toLowerCase() === 'json');
}
