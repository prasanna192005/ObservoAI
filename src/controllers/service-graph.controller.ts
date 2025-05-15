import { Controller, Get } from '@nestjs/common';
import { ServiceGraphService } from '../services/service-graph.service';

@Controller()
export class ServiceGraphController {
  constructor(private readonly serviceGraphService: ServiceGraphService) {}

  @Get('service-graph')
  async getServiceGraph() {
    try {
      const graph = await this.serviceGraphService.getServiceGraph();
      return {
        status: 200,
        data: graph
      };
    } catch (error) {
      return {
        status: 500,
        error: error.message
      };
    }
  }
} 