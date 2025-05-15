"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiGrafanaService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const generative_ai_1 = require("@google/generative-ai");
const axios_1 = require("axios");
let GeminiGrafanaService = class GeminiGrafanaService {
    constructor(configService) {
        this.configService = configService;
        this.lokiUrl = 'http://loki:3100';
        this.tempoUrl = 'http://tempo:3200';
        this.prometheusUrl = 'http://prometheus:9090';
        this.genAI = new generative_ai_1.GoogleGenerativeAI('AIzaSyDkJsex6-NTMDd3MrS7-TSj2O58N8gxLko');
    }
    async getLokiLogs() {
        try {
            const response = await axios_1.default.get(`${this.lokiUrl}/loki/api/v1/query_range`, {
                params: {
                    query: '{job="default"}',
                    limit: 100,
                    start: (Date.now() - 3600000) * 1000000,
                    end: Date.now() * 1000000
                }
            });
            return response.data;
        }
        catch (error) {
            console.error('Error fetching Loki logs:', error);
            return [];
        }
    }
    async getTraces() {
        try {
            const response = await axios_1.default.get(`${this.tempoUrl}/api/traces`);
            return response.data;
        }
        catch (error) {
            console.error('Error fetching traces:', error);
            return [];
        }
    }
    async getMetrics() {
        try {
            const response = await axios_1.default.get(`${this.prometheusUrl}/api/v1/query`, {
                params: {
                    query: 'up'
                }
            });
            return response.data;
        }
        catch (error) {
            console.error('Error fetching metrics:', error);
            return [];
        }
    }
    async queryGrafana(query) {
        try {
            const [logs, traces, metrics] = await Promise.all([
                this.getLokiLogs(),
                this.getTraces(),
                this.getMetrics()
            ]);
            const context = `
        System Context:
        - Logs from Loki: ${JSON.stringify(logs)}
        - Traces from Tempo: ${JSON.stringify(traces)}
        - Metrics from Prometheus: ${JSON.stringify(metrics)}
        
        User Query: ${query}
        
        Please analyze this data and provide insights.
      `;
            const model = this.genAI.getGenerativeModel({
                model: "gemini-2.5-flash-preview-04-17",
                generationConfig: {
                    temperature: 0.9,
                    topK: 1,
                    topP: 1,
                    maxOutputTokens: 2048,
                },
            });
            const result = await model.generateContent(context);
            const response = await result.response;
            return {
                time: Date.now(),
                value: response.text()
            };
        }
        catch (error) {
            console.error('Error:', error);
            return {
                time: Date.now(),
                value: 'Error occurred while processing query'
            };
        }
    }
};
exports.GeminiGrafanaService = GeminiGrafanaService;
exports.GeminiGrafanaService = GeminiGrafanaService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], GeminiGrafanaService);
//# sourceMappingURL=gemini-grafana.service.js.map