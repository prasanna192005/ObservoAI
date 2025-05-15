/*telemetry.js*/
// Shared OpenTelemetry instrumentation for distributed banking services
const opentelemetry = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { SemanticResourceAttributes, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } = require('@opentelemetry/semantic-conventions');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { PeriodicExportingMetricReader, MeterProvider } = require('@opentelemetry/sdk-metrics');
const { LoggerProvider, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const winston = require('winston');
const ecsFormat = require('@elastic/ecs-winston-format');

// Configure the trace context propagator
const contextManager = require('@opentelemetry/context-async-hooks');
const { CompositePropagator } = require('@opentelemetry/core');
const { B3InjectEncoding, B3Propagator } = require('@opentelemetry/propagator-b3');

// Initialize a tracer and meter provider
function initTelemetry(serviceName, environment) {
  // Set default values if not provided
  serviceName = serviceName || 'bank-api';
  environment = environment || 'development';
  
  // Enable OpenTelemetry debug logging in development - set to more verbose level
  opentelemetry.diag.setLogger(new opentelemetry.DiagConsoleLogger(), opentelemetry.DiagLogLevel.DEBUG);
  console.log(`[TELEMETRY DEBUG] Initializing telemetry for service: ${serviceName}, environment: ${environment}`);

  // Define resource information
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: '1.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT]: environment,
    'service.name': serviceName,
    'service.instance.id': `${serviceName}-${Math.random().toString(36).substring(2, 12)}`,
    'host.type': environment
  });
  console.log(`[TELEMETRY DEBUG] Resource created with service.name: '${serviceName}'`);

  // Configure OTLP exporters to send to OpenTelemetry Collector
  const traceExporter = new OTLPTraceExporter({
    url: 'http://otel-collector:4318/v1/traces', 
    headers: {
      'X-Service-Name': serviceName
    }
  });
  console.log(`[TELEMETRY DEBUG] Trace exporter configured with URL: http://otel-collector:4318/v1/traces`);

  const metricExporter = new OTLPMetricExporter({
    url: 'http://otel-collector:4318/v1/metrics',
    headers: {
      'X-Service-Name': serviceName
    }
  });
  console.log(`[TELEMETRY DEBUG] Metric exporter configured with URL: http://otel-collector:4318/v1/metrics`);

  const logExporter = new OTLPLogExporter({
    url: 'http://otel-collector:4318/v1/logs',
    headers: {
      'X-Service-Name': serviceName
    },
    timeoutMillis: 15000
  });
  console.log(`[TELEMETRY DEBUG] Log exporter configured with URL: http://otel-collector:4318/v1/logs`);

  // Initialize MeterProvider
  const meterProvider = new MeterProvider({
    resource: resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 10000, // Export metrics every 10 seconds
      })
    ]
  });
  console.log(`[TELEMETRY DEBUG] MeterProvider initialized`);

  // Set the global MeterProvider
  opentelemetry.metrics.setGlobalMeterProvider(meterProvider);

  // Create a meter to use for instrumentation
  const meter = opentelemetry.metrics.getMeter(serviceName, '1.0.0');
  console.log(`[TELEMETRY DEBUG] Meter created for service: ${serviceName}`);

  // Initialize LoggerProvider with more detailed configuration
  const loggerProvider = new LoggerProvider({
    resource: resource,
  });
  console.log(`[TELEMETRY DEBUG] LoggerProvider initialized`);

  // Add the OTLP log processor
  loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));
  console.log(`[TELEMETRY DEBUG] Added OTLP log processor with URL: http://otel-collector:4318/v1/logs`);

  // Create a winston logger that includes trace context in logs
  const logger = winston.createLogger({
    level: 'info',
    format: ecsFormat({ 
      convertReqRes: true,
      apmIntegration: true
    }),
    defaultMeta: { 
      service: serviceName,
      environment: environment
    },
    transports: [
      // Console transport for local visibility
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      }),
    ]
  });
  console.log(`[TELEMETRY DEBUG] Winston logger initialized with ECS format`);

  // Set up a custom formatter to include trace context
  const addTraceContext = winston.format((info) => {
    const span = opentelemetry.trace.getActiveSpan();
    if (span) {
      const context = span.spanContext();
      info.trace = {
        span_id: context.spanId,
        trace_id: context.traceId
      };
    }
    return info;
  });

  // Apply the formatter to the logger
  logger.format = winston.format.combine(
    addTraceContext(),
    logger.format
  );
  console.log(`[TELEMETRY DEBUG] Added trace context to Winston logger`);

  // Wrap Winston logger methods to send logs to OpenTelemetry
  ['info', 'warn', 'error', 'debug'].forEach(level => {
    const originalMethod = logger[level];
    
    logger[level] = function(message, meta = {}) {
      // Call the original Winston method
      originalMethod.call(logger, message, meta);
      
      // Also log to OpenTelemetry
      try {
        const otelLogger = loggerProvider.getLogger('winston-logger');
        console.log(`[TELEMETRY DEBUG] Sending log to OTLP: ${level} - ${message}`);
        otelLogger.emit({
          severityText: level,
          body: message,
          attributes: { 
            ...meta, 
            'service.name': serviceName,
            'log.origin': 'winston-wrapper'
          }
        });
      } catch (error) {
        console.error(`[TELEMETRY ERROR] Failed to emit log to OpenTelemetry: ${error.message}`, error);
      }
    };
  });
  console.log(`[TELEMETRY DEBUG] Wrapped Winston methods to send logs to OpenTelemetry`);

  // Initialize the SDK with tracing
  const sdk = new NodeSDK({
    resource: resource,
    traceExporter: traceExporter,
    contextManager: new contextManager.AsyncHooksContextManager(),
    instrumentations: [
      new HttpInstrumentation({
        // Add service name as an attribute to every span
        requestHook: (span) => {
          span.setAttribute('service.name', serviceName);
        }
      }),
      new ExpressInstrumentation({
        // Add service name as an attribute to every span
        requestHook: (span) => {
          span.setAttribute('service.name', serviceName);
        }
      })
    ],
    // Use both W3C and B3 propagation for maximum compatibility
    textMapPropagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER })
      ],
    }),
  });
  console.log(`[TELEMETRY DEBUG] NodeSDK initialized`);

  // Start the SDK
  sdk.start();
  console.log(`[TELEMETRY DEBUG] NodeSDK started`);

  // Create test logs after a delay to confirm setup
  setTimeout(() => {
    console.log(`[TELEMETRY DEBUG] Sending test logs`);
    logger.info('Test log message for Elasticsearch via OpenTelemetry', { test: true });
    logger.error('Test error message for Elasticsearch via OpenTelemetry', { test: true });
    
    // Also log directly via OpenTelemetry for testing
    const directLogger = loggerProvider.getLogger('direct-test');
    directLogger.emit({
      severityText: 'info',
      body: 'Direct OpenTelemetry test log message',
      attributes: { test: true, method: 'direct', 'service.name': serviceName }
    });
    
    console.log(`[TELEMETRY DEBUG] Test logs sent, check Elasticsearch and collector logs`);
  }, 5000);

  // Create metric instruments
  const requestCounter = meter.createCounter('bank.http_requests_total', {
    description: 'Total number of HTTP requests',
    unit: '1',
  });

  const requestDurationHistogram = meter.createHistogram('bank.http_request_duration_seconds', {
    description: 'HTTP request duration in seconds',
    unit: 's',
  });

  // --- ANOMALY DETECTION METRICS ---
  // 1. Response Time Anomaly Detection Metrics
  const routeLatencyHistogram = meter.createHistogram('bank.route_latency_seconds', {
    description: 'API route-specific latency measurements for anomaly detection',
    unit: 's',
  });

  const crossServiceLatencyHistogram = meter.createHistogram('bank.cross_service_latency_seconds', {
    description: 'Latency of calls between services across environments',
    unit: 's',
  });

  const baselineLatencyGauge = meter.createUpDownCounter('bank.baseline_latency_seconds', {
    description: 'Rolling baseline latency for comparison',
    unit: 's',
  });

  // 2. Error Anomaly Detection Metrics
  const categorizedErrorCounter = meter.createCounter('bank.errors_categorized_total', {
    description: 'Categorized error counts for anomaly detection',
    unit: '1',
  });

  const errorRateGauge = meter.createUpDownCounter('bank.error_rate', {
    description: 'Error rate as percentage of total requests',
    unit: '%',
  });

  // 3. Pattern Change Detection Metrics
  const periodicLatencySummary = meter.createHistogram('bank.periodic_latency_summary', {
    description: 'Periodic (hourly) latency summary for trend analysis',
    unit: 's',
  });

  // 4. Predictive Failure Metrics
  const earlyWarningSignalsCounter = meter.createCounter('bank.early_warning_signals', {
    description: 'Count of potential early warning signals for failures',
    unit: '1',
  });

  const resourceUtilizationGauge = meter.createUpDownCounter('bank.resource_utilization', {
    description: 'Resource utilization metrics for capacity prediction',
    unit: '%',
  });

  // Keep existing metrics
  const transactionValueCounter = meter.createCounter('bank.transaction_value_total', {
    description: 'Total value of transactions processed',
    unit: 'USD',
  });

  const activeUsersGauge = meter.createUpDownCounter('bank.active_users', {
    description: 'Number of active users',
    unit: '1',
  });

  const errorCounter = meter.createCounter('bank.errors_total', {
    description: 'Total number of errors',
    unit: '1',
  });

  // Account service metrics
  const accountCounter = meter.createCounter('bank.accounts_total', {
    description: 'Total number of accounts created',
    unit: '1',
  });

  const accountStatusChangeCounter = meter.createCounter('bank.account_status_changes_total', {
    description: 'Total number of account status changes',
    unit: '1',
  });

  const insufficientFundsCounter = meter.createCounter('bank.insufficient_funds_total', {
    description: 'Total number of insufficient funds errors',
    unit: '1',
  });

  const transferProcessingTime = meter.createHistogram('bank.transfer_processing_time_seconds', {
    description: 'Transfer processing time in seconds',
    unit: 's',
  });

  const transferCounter = meter.createCounter('bank.transfers_total', {
    description: 'Total number of transfers',
    unit: '1',
  });

  const transferAmountSum = meter.createHistogram('bank.transfer_amount_dollars', {
    description: 'Transfer amounts in dollars',
    unit: 'USD',
  });

  const serviceCallDurationHistogram = meter.createHistogram('bank.service_call_duration_seconds', {
    description: 'Service call duration in seconds',
    unit: 's',
  });

  const serviceCallErrorCounter = meter.createCounter('bank.service_call_errors_total', {
    description: 'Total number of service call errors',
    unit: '1',
  });

  // Transaction service metrics
  const transactionProcessingTime = meter.createHistogram('bank.transaction_processing_time_seconds', {
    description: 'Transaction processing time in seconds',
    unit: 's',
  });

  const transactionCounter = meter.createCounter('bank.transactions_total', {
    description: 'Total number of transactions processed',
    unit: '1',
  });

  const transactionAmountSum = meter.createHistogram('bank.transaction_amount_dollars', {
    description: 'Transaction amounts in dollars',
    unit: 'USD',
  });

  // Return all initialized components
  return {
    logger,
    meter,
    metrics: {
      requestCounter,
      requestDurationHistogram,
      transactionValueCounter,
      activeUsersGauge,
      errorCounter,
      accountCounter,
      accountStatusChangeCounter,
      insufficientFundsCounter,
      transferProcessingTime,
      transferCounter,
      transferAmountSum,
      serviceCallDurationHistogram,
      serviceCallErrorCounter,
      transactionProcessingTime,
      transactionCounter,
      transactionAmountSum,
      routeLatencyHistogram,
      crossServiceLatencyHistogram,
      baselineLatencyGauge,
      categorizedErrorCounter,
      errorRateGauge,
      periodicLatencySummary,
      earlyWarningSignalsCounter,
      resourceUtilizationGauge
    },
    sdk,
    loggerProvider
  };
}

module.exports = {
  initTelemetry
}; 