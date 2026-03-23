import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * Global API Key guard for service-to-service auth.
 * Checks `X-API-Key` header against `API_KEY` env var.
 * If API_KEY is not set → all requests pass (dev mode).
 * Routes decorated with @Public() are always allowed.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expectedKey: string | undefined;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    this.expectedKey = this.config.get<string>('API_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    // @Public() routes skip auth
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // No API_KEY configured → open (dev mode)
    if (!this.expectedKey) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      throw new UnauthorizedException('Missing X-API-Key header');
    }
    if (apiKey !== this.expectedKey) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
