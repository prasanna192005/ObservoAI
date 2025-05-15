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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiGrafanaController = void 0;
const common_1 = require("@nestjs/common");
const gemini_grafana_service_1 = require("../services/gemini-grafana.service");
let GeminiGrafanaController = class GeminiGrafanaController {
    constructor(geminiGrafanaService) {
        this.geminiGrafanaService = geminiGrafanaService;
    }
    async query(body) {
        console.log('Raw body received:', body);
        const defaultQuery = "Please analyze the system's current state including logs, traces, and metrics.";
        const query = body?.query || defaultQuery;
        return this.geminiGrafanaService.queryGrafana(query);
    }
    async test() {
        return { status: 'ok' };
    }
};
exports.GeminiGrafanaController = GeminiGrafanaController;
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], GeminiGrafanaController.prototype, "query", null);
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], GeminiGrafanaController.prototype, "test", null);
exports.GeminiGrafanaController = GeminiGrafanaController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [gemini_grafana_service_1.GeminiGrafanaService])
], GeminiGrafanaController);
//# sourceMappingURL=gemini-grafana.controller.js.map