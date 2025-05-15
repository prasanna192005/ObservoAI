import { ConfigService } from '@nestjs/config';
export declare class GeminiGrafanaService {
    private configService;
    private genAI;
    private lokiUrl;
    private tempoUrl;
    private prometheusUrl;
    constructor(configService: ConfigService);
    private getLokiLogs;
    private getTraces;
    private getMetrics;
    queryGrafana(query: string): Promise<any>;
}
