/*instrumentation.js*/
// Require dependencies
const opentelemetry = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } = require('@opentelemetry/semantic-conventions');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { PeriodicExportingMetricReader, MeterProvider } = require('@opentelemetry/sdk-metrics');
const { LoggerProvider, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const winston = require('winston');
const ecsFormat = require('@elastic/ecs-winston-format');

// Enable debugging
opentelemetry.diag.setLogger(new opentelemetry.DiagConsoleLogger(), opentelemetry.DiagLogLevel.INFO);

// Create resource
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'dice-roll-app',
  [ATTR_SERVICE_VERSION]: '1.0.0',
  [ATTR_DEPLOYMENT_ENVIRONMENT]: 'development'
});

// Configure OTLP exporters - Use otel-collector service name or host IP
const traceExporter = new OTLPTraceExporter({
  url: 'http://otel-collector:4318/v1/traces', // Use service name in Docker
  headers: {}
});

const metricExporter = new OTLPMetricExporter({
  url: 'http://otel-collector:4318/v1/metrics', // Use service name in Docker
  headers: {}
});

const logExporter = new OTLPLogExporter({
  url: 'http://otel-collector:4318/v1/logs', // Use service name in Docker
  headers: {}
});

// Initialize the metric reader
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 10000, // Export metrics every 10 seconds
});

// Create and register the MeterProvider
const meterProvider = new MeterProvider({
  resource: resource,
  readers: [metricReader],
});

// Set the global MeterProvider
opentelemetry.metrics.setGlobalMeterProvider(meterProvider);

// Create a meter to use for instrumentation
const meter = opentelemetry.metrics.getMeter('dice-roll-app', '1.0.0');

// Create metrics instruments
const requestCounter = meter.createCounter('http_requests_total', {
  description: 'Total number of HTTP requests',
  unit: '1',
});

const requestDurationHistogram = meter.createHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 's',
});

// Initialize LoggerProvider
const loggerProvider = new LoggerProvider({
  resource: resource,
});
loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));

// Configure Winston logger with ECS format
const logger = winston.createLogger({
  level: 'info',
  format: ecsFormat({ convertReqRes: true }), // Use ECS format for Elasticsearch/APM
  defaultMeta: { service: 'dice-roll-app' },
  transports: [
    new winston.transports.Console(),
  ]
});

// Create a custom Winston logger that also logs to OpenTelemetry
const originalLoggerMethods = {
  info: logger.info,
  warn: logger.warn,
  error: logger.error,
  debug: logger.debug,
};

// Wrap Winston logger methods to send logs to OpenTelemetry
['info', 'warn', 'error', 'debug'].forEach(level => {
  logger[level] = function(message, meta) {
    // Call the original Winston method
    originalLoggerMethods[level].call(logger, message, meta);
    
    // Also log to OpenTelemetry
    const otelLogger = loggerProvider.getLogger('winston-logger');
    otelLogger.emit({
      severityText: level,
      body: message,
      attributes: meta || {}
    });
  };
});

// Initialize and start the OpenTelemetry SDK
const sdk = new NodeSDK({
  resource: resource,
  traceExporter,
  // Don't configure metrics or logs here since we've done it separately
  instrumentations: [getNodeAutoInstrumentations()]
});

// Export the logger and metrics for use in the application
module.exports = {
  logger,
  sdk,
  metrics: {
    requestCounter,
    requestDurationHistogram
  }
};

sdk.start();
