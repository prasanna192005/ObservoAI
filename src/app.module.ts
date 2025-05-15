import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiGrafanaController } from './controllers/gemini-grafana.controller';
import { GeminiGrafanaService } from './services/gemini-grafana.service';
import { ServiceGraphController } from './controllers/service-graph.controller';
import { ServiceGraphService } from './services/service-graph.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [GeminiGrafanaController, ServiceGraphController],
  providers: [GeminiGrafanaService, ServiceGraphService],
})
export class AppModule {} 