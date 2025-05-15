/*telemetry-middleware.js*/
// Middleware for enhanced telemetry collection focused on anomaly detection

// Tracking historical data for baselines (in-memory, would use a DB in production)
const latencyBaselines = new Map(); // route -> {avg, count, p95, p99}
const errorRates = new Map();       // route -> {count, total, rate}
const warningSignals = new Set();   // Set of current warning signals

// Window size for baseline calculations
const BASELINE_WINDOW_SIZE = 100;    // Number of requests to include in baseline
const ANOMALY_THRESHOLD = 2.0;       // Multiple of baseline for anomaly detection
const ERROR_RATE_THRESHOLD = 0.05;   // 5% error rate threshold
const PATTERN_WINDOW_SIZE = 3600000; // 1 hour in ms

// Calculate a moving average
function updateMovingAverage(key, newValue, window = BASELINE_WINDOW_SIZE) {
  if (!latencyBaselines.has(key)) {
    latencyBaselines.set(key, { avg: newValue, count: 1, values: [newValue], p95: newValue, p99: newValue });
    return newValue;
  }
  
  const baseline = latencyBaselines.get(key);
  
  // Update the moving average
  baseline.avg = ((baseline.avg * baseline.count) + newValue) / (baseline.count + 1);
  baseline.count++;
  
  // Keep a window of recent values for percentile calculations
  baseline.values.push(newValue);
  if (baseline.values.length > window) {
    baseline.values.shift();
  }
  
  // Calculate percentiles
  const sortedValues = [...baseline.values].sort((a, b) => a - b);
  const p95Index = Math.floor(sortedValues.length * 0.95);
  const p99Index = Math.floor(sortedValues.length * 0.99);
  
  baseline.p95 = sortedValues[p95Index] || baseline.avg;
  baseline.p99 = sortedValues[p99Index] || baseline.avg;
  
  return baseline;
}

// Update error rates
function updateErrorRate(route, isError) {
  if (!errorRates.has(route)) {
    errorRates.set(route, { count: isError ? 1 : 0, total: 1, rate: isError ? 1.0 : 0.0 });
    return isError ? 1.0 : 0.0;
  }
  
  const stats = errorRates.get(route);
  stats.total++;
  if (isError) stats.count++;
  stats.rate = stats.count / stats.total;
  
  return stats.rate;
}

// Check for early warning signals
function checkForWarningSignals(route, latency, baseline, errorRate) {
  const signals = [];
  
  // Latency approaching threshold
  if (latency > baseline.avg * (ANOMALY_THRESHOLD * 0.8)) {
    signals.push('LATENCY_APPROACHING_THRESHOLD');
  }
  
  // Error rate approaching threshold
  if (errorRate > ERROR_RATE_THRESHOLD * 0.8) {
    signals.push('ERROR_RATE_APPROACHING_THRESHOLD');
  }
  
  // Pattern changes - sudden shifts in P95/P99
  if (baseline.count > 10 && Math.abs(latency - baseline.p95) > baseline.avg) {
    signals.push('P95_PATTERN_SHIFT');
  }
  
  return signals;
}

// Create the middleware
function createTelemetryMiddleware(metrics) {
  return function telemetryMiddleware(req, res, next) {
    // Start timing the request
    const startTime = process.hrtime();
    const route = `${req.method}:${req.route ? req.route.path : req.path}`;
    
    // Add service environment context
    req.serviceContext = {
      environment: req.app.get('environment') || 'unknown',
      serviceName: req.app.get('serviceName') || 'unknown'
    };
    
    // Track cross-service request origins
    const sourceService = req.headers['x-source-service'];
    const sourceEnv = req.headers['x-source-environment'];
    
    // Intercept response to collect metrics
    const originalSend = res.send;
    res.send = function(body) {
      // Calculate request duration
      const hrDuration = process.hrtime(startTime);
      const durationSec = hrDuration[0] + hrDuration[1] / 1e9;
      
      // Basic request metrics
      metrics.requestCounter.add(1, {
        route,
        method: req.method,
        service: req.serviceContext.serviceName,
        environment: req.serviceContext.environment
      });
      
      metrics.requestDurationHistogram.record(durationSec, {
        route,
        method: req.method,
        service: req.serviceContext.serviceName,
        environment: req.serviceContext.environment,
        statusCode: res.statusCode
      });
      
      // Enhanced metrics for anomaly detection
      // 1. Route-specific latency
      metrics.routeLatencyHistogram.record(durationSec, {
        route,
        method: req.method,
        service: req.serviceContext.serviceName,
        environment: req.serviceContext.environment,
        statusCode: res.statusCode
      });
      
      // 2. Cross-service latency (if applicable)
      if (sourceService && sourceEnv) {
        metrics.crossServiceLatencyHistogram.record(durationSec, {
          source: sourceService,
          sourceEnv: sourceEnv,
          target: req.serviceContext.serviceName,
          targetEnv: req.serviceContext.environment,
          route
        });
      }
      
      // 3. Update baseline and check for anomalies
      const isError = res.statusCode >= 400;
      const baseline = updateMovingAverage(route, durationSec);
      const errorRate = updateErrorRate(route, isError);
      
      // Set baseline metric
      metrics.baselineLatencyGauge.add(0, {  // Use add(0) to just update labels without changing value
        route,
        avg: baseline.avg.toFixed(4),
        p95: baseline.p95.toFixed(4),
        p99: baseline.p99.toFixed(4)
      });
      
      // Error rate metrics
      metrics.errorRateGauge.add(0, {  // Use add(0) to just update labels
        route,
        rate: errorRate.toFixed(4),
        service: req.serviceContext.serviceName
      });
      
      // Check if this is an anomaly
      let isLatencyAnomaly = false;
      if (baseline.count > 10) {  // Only after we have enough data
        if (durationSec > baseline.p95 * ANOMALY_THRESHOLD) {
          isLatencyAnomaly = true;
          // Log anomaly
          console.log(`[ANOMALY] Latency spike detected for ${route}: ${durationSec.toFixed(4)}s vs baseline P95 ${baseline.p95.toFixed(4)}s`);
        }
      }
      
      // Check for error rate anomalies
      let isErrorAnomaly = false;
      if (errorRate > ERROR_RATE_THRESHOLD) {
        isErrorAnomaly = true;
        console.log(`[ANOMALY] High error rate detected for ${route}: ${(errorRate * 100).toFixed(2)}% exceeds threshold of ${(ERROR_RATE_THRESHOLD * 100).toFixed(2)}%`);
      }
      
      // If error, track categorized errors
      if (isError) {
        let errorCategory = 'unknown';
        let errorSource = req.serviceContext.serviceName;
        
        // Try to categorize error
        if (res.statusCode === 400) errorCategory = 'validation';
        else if (res.statusCode === 401 || res.statusCode === 403) errorCategory = 'authorization';
        else if (res.statusCode === 404) errorCategory = 'not_found';
        else if (res.statusCode === 429) errorCategory = 'rate_limit';
        else if (res.statusCode >= 500) errorCategory = 'server_error';
        
        metrics.categorizedErrorCounter.add(1, {
          route,
          status: res.statusCode.toString(),
          category: errorCategory,
          service: errorSource,
          environment: req.serviceContext.environment
        });
      }
      
      // Check for early warning signals
      const warningSignals = checkForWarningSignals(route, durationSec, baseline, errorRate);
      if (warningSignals.length > 0) {
        warningSignals.forEach(signal => {
          metrics.earlyWarningSignalsCounter.add(1, {
            signal,
            route,
            service: req.serviceContext.serviceName,
            environment: req.serviceContext.environment
          });
          
          console.log(`[WARNING] Potential issue detected: ${signal} on ${route} in ${req.serviceContext.serviceName}`);
        });
      }
      
      // For hourly pattern analysis (simplified)
      const hourBucket = Math.floor(Date.now() / PATTERN_WINDOW_SIZE);
      metrics.periodicLatencySummary.record(durationSec, {
        route,
        hourBucket: hourBucket.toString(),
        service: req.serviceContext.serviceName
      });
      
      return originalSend.call(this, body);
    };
    
    next();
  };
}

module.exports = { createTelemetryMiddleware }; 