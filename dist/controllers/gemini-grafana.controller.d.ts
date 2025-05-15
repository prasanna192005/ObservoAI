import { GeminiGrafanaService } from '../services/gemini-grafana.service';
export declare class GeminiGrafanaController {
    private readonly geminiGrafanaService;
    constructor(geminiGrafanaService: GeminiGrafanaService);
    query(body: any): Promise<any>;
    test(): Promise<{
        status: string;
    }>;
}
