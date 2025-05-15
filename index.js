/*app.js*/
// Import OpenTelemetry instrumentation first
const { logger, metrics } = require('./instrumentation');
const express = require('express');

const PORT = parseInt(process.env.PORT || '8080');
const app = express();

function getRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// Add middleware to track request metrics
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Count the request
  metrics.requestCounter.add(1, {
    method: req.method,
    path: req.path,
  });
  
  // Track response time
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = (Date.now() - startTime) / 1000; // convert to seconds
    metrics.requestDurationHistogram.record(duration, {
      method: req.method,
      path: req.path,
      status_code: res.statusCode.toString()
    });
    
    logger.info('Request completed', {
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: duration * 1000
    });
    
    return originalEnd.apply(this, args);
  };
  next();
});

app.get('/rolldice', (req, res) => {
  const result = getRandomNumber(1, 6);
  logger.info('Dice rolled', { result, path: req.path, method: req.method });
  res.send(result.toString());
});

// Add a health check endpoint
app.get('/health', (req, res) => {
  logger.info('Health check', { status: 'OK', path: req.path, method: req.method });
  res.status(200).json({ status: 'OK' });
});

// Add error handling middleware
app.use((err, req, res, next) => {
  logger.error('Application error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  logger.info(`Server started`, { port: PORT, url: `http://localhost:${PORT}` });
});
