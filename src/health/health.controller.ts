import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/index.js';
import { HealthService } from './health.service.js';

@ApiTags('Health')
@Controller()
@Public()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async getHealth() {
    return this.healthService.getHealth();
  }
}
