import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';

interface LogsResponse {
  data?: {
    result?: any[];
  };
}

@Injectable()
export class GeminiGrafanaService {
  private genAI: GoogleGenerativeAI;
  private lokiUrl = 'http://loki:3100';
  private tempoUrl = 'http://tempo:3200';
  private prometheusUrl = 'http://prometheus:9090';
  private model: any;

  constructor(private configService: ConfigService) {
    this.genAI = new GoogleGenerativeAI('AIzaSyBxXG54stiUZI09SWayH-H0wfGKGgK9b5U');
    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-1.5-flash', // Updated to stable model
      generationConfig: {
        temperature: 0.7,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
      },
    });
  }

  private async getLokiLogs() {
    try {
      const url = `${this.lokiUrl}/loki/api/v1/query_range?query={ job=~"account-service|customer-api-service|customer-service|transaction-service" }&limit=1000`;
      console.log('Requesting Loki URL:', url);
      
      const response = await axios.get(url);
      console.log('Loki response status:', response.status);
      if (response.data && response.data.data) {
        console.log('Found', response.data.data.result?.length || 0, 'log entries');
      }
      return response.data;
    } catch (error) {
      console.error('Error fetching Loki logs:', error.message);
      if (error.response) {
        console.error('Error response:', error.response.data);
      }
      return [];
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
          query: 'up'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching metrics:', error);
      return [];
    }
  }

  async queryGrafana(query: string): Promise<any> {
    try {
      // Get data from all sources
      const [logs] = await Promise.all([
        this.getLokiLogs(),
        // this.getTraces(),
        // this.getMetrics()
      ]);

      return {
        logs,
        // traces,
        // metrics,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error in queryGrafana:', error);
      throw new Error(`Failed to fetch Grafana data: ${error.message}`);
    }
  }

  async analyzeWithGemini(query: string, data: any): Promise<any> {
    try {
      console.log('Starting Gemini analysis for query:', query);
      
      // Extract log entries from the Loki response
      const logEntries = data.logs?.data?.result?.[0]?.values || [];
      const formattedLogs = logEntries.map(([timestamp, message]) => ({
        timestamp: new Date(parseInt(timestamp) / 1000000).toISOString(),
        message
      }));

      // Check if logs are empty
      if (!formattedLogs.length) {
        console.warn('No log entries available for analysis');
        return {
          value: 'No log entries available to analyze. Please check the data source or query.',
          time: new Date().toISOString()
        };
      }

      const context = `
        You are a system monitoring assistant. Analyze the following logs and provide insights based on the user's query. If the query is vague or unclear, provide a general analysis of the logs, focusing on errors, warnings, and system health.

        User Query: "${query}"

        Log Entries:
        ${JSON.stringify(formattedLogs, null, 2)}

        Please provide a detailed analysis focusing on:
        1. Any errors or warnings in the logs
        2. System behavior patterns
        3. Specific insights related to the user's query (or general insights if the query is unclear)
        4. Recommendations if any issues are found

        Format your response in clear, concise paragraphs.
      `;

      console.log('Sending to Gemini:', context);
      
      const result = await this.model.generateContent(context);
      const response = await result.response;
      console.log('Raw Gemini response:', response);
      const text = response.text();
      
      console.log('Parsed Gemini response text:', text);

      if (!text || text.trim() === '') {
        throw new Error('Empty response from Gemini');
      }

      return {
        value: text,
        time: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error in analyzeWithGemini:', {
        message: error.message,
        stack: error.stack,
        query
      });
      throw new Error(`Gemini Analysis failed: ${error.message}`);
    }
  }
}