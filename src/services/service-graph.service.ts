import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ServiceGraphService {
  private tempoUrl: string;
  private prometheusUrl: string;

  constructor(private configService: ConfigService) {
    this.tempoUrl = this.configService.get<string>('TEMPO_URL') || 'http://localhost:3200';
    this.prometheusUrl = this.configService.get<string>('PROMETHEUS_URL') || 'http://localhost:9090';
  }

  async getServiceGraph() {
    try {
      // Get traces from Tempo
      const traces = await this.getTraces();
      
      // Get metrics from Prometheus
      const metrics = await this.getMetrics();
      
      // Process traces to build service graph
      const serviceGraph = this.processTraces(traces, metrics);
      
      return {
        nodes: serviceGraph.nodes,
        edges: serviceGraph.edges,
        metrics: serviceGraph.metrics
      };
    } catch (error) {
      console.error('Error generating service graph:', error);
      throw error;
    }
  }

  private async getTraces() {
    try {
      const response = await axios.get(`${this.tempoUrl}/api/traces`);
      return response.data;
    } catch (error) {
      console.error('Error fetching traces:', error);
      return [];
    }
  }

  private async getMetrics() {
    try {
      const response = await axios.get(`${this.prometheusUrl}/api/v1/query`, {
        params: {
          query: 'rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching metrics:', error);
      return [];
    }
  }

  private processTraces(traces: any[], metrics: any) {
    const nodes = new Set<string>();
    const edges = new Map<string, any>();
    const serviceMetrics = new Map<string, any>();

    // Process traces to extract service interactions
    traces.forEach(trace => {
      const spans = trace.spans || [];
      spans.forEach(span => {
        const serviceName = span.process?.serviceName || 'unknown';
        nodes.add(serviceName);

        // Extract parent-child relationships
        if (span.parentSpanId) {
          const parentSpan = spans.find(s => s.spanId === span.parentSpanId);
          if (parentSpan) {
            const parentService = parentSpan.process?.serviceName || 'unknown';
            const edgeKey = `${parentService}->${serviceName}`;
            
            if (!edges.has(edgeKey)) {
              edges.set(edgeKey, {
                source: parentService,
                target: serviceName,
                count: 0,
                errorCount: 0,
                avgDuration: 0
              });
            }
            
            const edge = edges.get(edgeKey);
            edge.count++;
            if (span.tags?.some(tag => tag.key === 'error' && tag.value === 'true')) {
              edge.errorCount++;
            }
            edge.avgDuration = (edge.avgDuration * (edge.count - 1) + span.duration) / edge.count;
          }
        }
      });
    });

    // Process metrics
    if (metrics?.data?.result) {
      metrics.data.result.forEach(result => {
        const serviceName = result.metric?.service || 'unknown';
        const value = parseFloat(result.value[1]);
        
        if (!serviceMetrics.has(serviceName)) {
          serviceMetrics.set(serviceName, {
            latency: 0,
            errorRate: 0,
            requestRate: 0
          });
        }
        
        const metric = serviceMetrics.get(serviceName);
        metric.latency = value;
      });
    }

    return {
      nodes: Array.from(nodes).map(name => ({
        id: name,
        name,
        metrics: serviceMetrics.get(name) || {}
      })),
      edges: Array.from(edges.values()).map(edge => ({
        ...edge,
        errorRate: edge.errorCount / edge.count
      }))
    };
  }
} 