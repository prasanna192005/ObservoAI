# Banking API Anomaly Detection

This README documents the anomaly detection capabilities implemented in the Banking API monitoring system.

## Overview

The anomaly detection framework is designed to identify unusual behavior across the banking microservices, including:

1. **Response Time Spike Detection** - Identifying when API response times suddenly increase
2. **Pattern Change Detection** - Detecting subtle shifts in performance patterns
3. **Error Rate Anomaly Detection** - Alerting when error rates exceed normal thresholds
4. **Predictive Failure Analytics** - Identifying early warning signals before major issues occur

## Implementation Details

### Metrics Collection

The following specialized metrics are collected for anomaly detection:

- `bank.route_latency_seconds` - Route-specific latency measurements
- `bank.cross_service_latency_seconds` - Latency of calls between services across environments
- `bank.baseline_latency_seconds` - Rolling baseline latency for comparison
- `bank.errors_categorized_total` - Categorized error counts
- `bank.error_rate` - Error rate as percentage of total requests
- `bank.periodic_latency_summary` - Periodic latency summaries for trend analysis
- `bank.early_warning_signals` - Count of potential early warning signals
- `bank.resource_utilization` - Resource utilization metrics

### Anomaly Detection Middleware

The system uses a specialized middleware (`telemetry-middleware.js`) that:

1. Maintains in-memory baselines for response times
2. Calculates P95 and P99 percentiles for each route
3. Tracks error rates and categories
4. Detects pattern changes over time
5. Identifies early warning signals

### Anomaly Thresholds

- **Latency Anomalies**: Response time > 2.0x the P95 baseline
- **Error Rate Anomalies**: Error rate > 5% of total requests
- **Pattern Changes**: Significant deviation from established patterns
- **Early Warnings**: Various signals including approaching thresholds

## How to Use

### Running Test Scenarios

Use the test data generator to simulate anomaly scenarios:

```
node node-api-monitoring/banking-services/generate-test-data.js
```

This will generate traffic with various anomaly patterns:

1. **Normal Traffic** - Baseline with 5% error rate
2. **Latency Spike** - Sudden increase in response times (account-service)
3. **Error Rate Spike** - Increased error rate (transaction-service)
4. **Pattern Change** - Subtle shift in response times (customer-service)
5. **Early Warning** - Gradually degrading performance (transaction-service)

### Monitoring Anomalies

1. **Grafana Dashboard**
   - Access the anomaly detection dashboard at `/grafana/d/anomaly-detection`
   - Observe real-time metrics for latency, error rates, and warning signals

2. **Logs**
   - Anomaly events are logged with `[ANOMALY]` prefix
   - Early warnings are logged with `[WARNING]` prefix
   - All anomaly events include detailed context

3. **Alerts**
   - Configure Grafana alerts on anomaly metrics
   - Set up notification channels for immediate response

## Architecture

The anomaly detection system works across different deployment environments:

- **Cloud Environment**: `customer-service` and `customer-api-service`
- **Hybrid Environment**: `account-service` 
- **On-Premises Environment**: `transaction-service`

Cross-service calls include environment context, enabling analysis of performance across environment boundaries.

## Future Enhancements

Planned improvements include:

1. **Machine Learning Models** - Replace static thresholds with ML-based anomaly detection
2. **Seasonality Awareness** - Account for time-of-day and day-of-week patterns
3. **Correlation Analysis** - Identify related anomalies across services
4. **Fault Injection** - Controlled chaos engineering to test resilience 