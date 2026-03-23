import { NestFactory, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { ApiKeyGuard } from './auth/index.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors(
    allowedOrigins?.length ? { origin: allowedOrigins, credentials: true } : undefined,
  );

  // Global API Key guard (service-to-service auth)
  const reflector = app.get(Reflector);
  const configService = app.get(ConfigService);
  app.useGlobalGuards(new ApiKeyGuard(reflector, configService));

  const config = new DocumentBuilder()
    .setTitle('Custody Gateway')
    .setDescription('API for Yellow Network ClearNode integration (sessions, channels, transfers)')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT ?? 3333);
}
void bootstrap();
