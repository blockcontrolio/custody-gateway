import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors(
    allowedOrigins?.length
      ? { origin: allowedOrigins, credentials: true }
      : undefined,
  );

  const config = new DocumentBuilder()
    .setTitle('Custody Gateway')
    .setDescription(
      'API for Yellow Network ClearNode integration (sessions, channels, transfers)',
    )
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT ?? 3333);
}
void bootstrap();
