import { Controller, Post, Body, Get } from '@nestjs/common';
import { GeminiGrafanaService } from '../services/gemini-grafana.service';

@Controller()
export class GeminiGrafanaController {
  constructor(private readonly geminiService: GeminiGrafanaService) {}

  @Get()
  async health() {
    return { status: 'ok' };
  }

  @Post()
  async query(@Body() body: any) {
    console.log('Received request body:', body);
    
    try {
      const query = body.query;
      if (!query) {
        throw new Error('Query is required');
      }
      
      console.log('Processing query:', query);
      
      // First get the Grafana data
      const grafanaData = await this.geminiService.queryGrafana(query);
      console.log('Received Grafana data:', grafanaData);
      
      // Then get Gemini's analysis
      const geminiAnalysis = await this.geminiService.analyzeWithGemini(query, grafanaData);
      console.log('Received Gemini analysis:', geminiAnalysis);
      
      if (!geminiAnalysis || !geminiAnalysis.value) {
        throw new Error('No analysis received from Gemini');
      }

      return {
        status: 200,
        data: [{
          query: query,
          analysis: geminiAnalysis.value,
          timestamp: geminiAnalysis.time
        }]
      };
      
    } catch (error) {
      console.error('Error processing query:', error);
      return {
        status: 500,
        error: error.message
      };
    }
  }

  @Get('/queries')
  async getAvailableQueries() {
    return {
      items: [
        { name: "Analyze system performance", value: "Analyze system performance" },
        { name: "Show recent errors", value: "Show recent errors" },
        { name: "Check system health", value: "Check system health" },
        { name: "Analyze log patterns", value: "Analyze log patterns" },
        { name: "System status overview", value: "System status overview" }
      ]
    };
  }
} 