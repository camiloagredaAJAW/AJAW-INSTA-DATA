import { BadRequestException, Body, Controller, Get, Headers, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
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
  constructor(
    private readonly configService: ConfigService<EnvironmentConfig, true>,
    private readonly activateInstagramIntegration: ActivateInstagramIntegrationService,
    private readonly instagramBusinessLogin: InstagramBusinessLoginService,
  ) {}

  @Get('login')
  async login(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query('agentId') agentId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    this.assertInternalApiKey(headers['x-internal-api-key'] ?? headers['internal-api-key']);

    if (!agentId || agentId.trim() === '') {
      throw new BadRequestException('agentId is required');
    }

    try {
      const result = await this.instagramBusinessLogin.start({ agentId });
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
