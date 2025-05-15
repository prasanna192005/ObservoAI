/*server.js - Customer API Service (Cloud)*/
// Import telemetry first for proper instrumentation
const { initTelemetry } = require('../telemetry');
const { logger, metrics } = initTelemetry('customer-api-service', 'cloud');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { customerOperations } = require('../database');
const { createTelemetryMiddleware } = require('../middleware/telemetry-middleware');

// Constants
const PORT = 3000;
const app = express();

// Store environment and service name for context
app.set('environment', 'cloud');
app.set('serviceName', 'customer-api-service');

// Track active sessions
const activeSessions = new Map();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Add anomaly detection telemetry middleware
app.use(createTelemetryMiddleware(metrics));

// Request tracking middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = uuidv4();
  const sessionId = req.headers['session-id'] || uuidv4();

  // Add trace context to logs
  logger.info('Request received', {
    requestId,
    sessionId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent']
  });

  // Track request with metrics
  metrics.requestCounter.add(1, {
    service: 'customer-api',
    method: req.method,
    path: req.path,
    environment: 'cloud'
  });

  // Track active sessions (increment)
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, Date.now());
    metrics.activeUsersGauge.add(1, {
      service: 'customer-api'
    });
  }

  // Add trace context to response headers
  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000; // seconds
    metrics.requestDurationHistogram.record(duration, {
      service: 'customer-api',
      method: req.method,
      path: req.path,
      status_code: res.statusCode.toString(),
      environment: 'cloud'
    });

    logger.info('Request completed', {
      requestId,
      sessionId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime
    });
  });

  // Add session and request ID to the request object for later use
  req.sessionId = sessionId;
  req.requestId = requestId;
  res.setHeader('X-Session-ID', sessionId);
  res.setHeader('X-Request-ID', requestId);

  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'customer-api', environment: 'cloud' });
});

// Get all customers
app.get('/api/customers', (req, res) => {
  try {
    const customers = customerOperations.getCustomers();
    // Remove sensitive information before returning
    const sanitizedCustomers = customers.map(customer => ({
      id: customer.id,
      name: customer.name,
      accountNumber: customer.accountNumber
    }));
    res.json(sanitizedCustomers);
  } catch (error) {
    logger.error('Failed to get customers', { error: error.message, stack: error.stack, requestId: req.requestId });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'getCustomers' });
    res.status(500).json({ error: 'Failed to get customers' });
  }
});

// Get customer details
app.get('/api/customers/:id', (req, res) => {
  try {
    const customer = customerOperations.getCustomerById(req.params.id);
    if (!customer) {
      logger.warn('Customer not found', { customerId: req.params.id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Remove sensitive information before returning
    const sanitizedCustomer = {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      accountNumber: customer.accountNumber
    };

    res.json(sanitizedCustomer);
  } catch (error) {
    logger.error('Failed to get customer', { 
      error: error.message, 
      stack: error.stack, 
      customerId: req.params.id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'getCustomer' });
    res.status(500).json({ error: 'Failed to get customer' });
  }
});

// Get account balance
app.get('/api/accounts/:accountNumber/balance', (req, res) => {
  try {
    const balance = customerOperations.getCustomerBalance(req.params.accountNumber);
    if (balance === null) {
      logger.warn('Account not found', { accountNumber: req.params.accountNumber, requestId: req.requestId });
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json({ accountNumber: req.params.accountNumber, balance });
  } catch (error) {
    logger.error('Failed to get balance', { 
      error: error.message, 
      stack: error.stack, 
      accountNumber: req.params.accountNumber, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'getBalance' });
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// Make deposit (forward to transaction service)
app.post('/api/accounts/:accountNumber/deposit', async (req, res) => {
  const { amount } = req.body;
  const { accountNumber } = req.params;
  
  if (!amount || isNaN(amount) || amount <= 0) {
    logger.warn('Invalid amount for deposit', { 
      amount, 
      accountNumber, 
      requestId: req.requestId 
    });
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  try {
    // Call transaction service
    const response = await axios.post('http://transaction-service:3004/api/transactions', {
      type: 'deposit',
      targetAccountNumber: accountNumber,
      amount
    }, {
      headers: {
        'X-Session-ID': req.sessionId,
        'X-Request-ID': req.requestId,
        'X-Source-Service': 'customer-api-service',
        'X-Source-Environment': 'cloud'
      }
    });
    
    logger.info('Deposit processed', { 
      accountNumber, 
      amount, 
      transactionId: response.data.transaction.id,
      requestId: req.requestId 
    });
    
    res.status(200).json(response.data);
  } catch (error) {
    logger.error('Failed to process deposit', { 
      error: error.message, 
      stack: error.stack, 
      accountNumber, 
      amount, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'deposit' });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({ error: 'Failed to process deposit' });
  }
});

// Make withdrawal (forward to transaction service)
app.post('/api/accounts/:accountNumber/withdrawal', async (req, res) => {
  const { amount } = req.body;
  const { accountNumber } = req.params;
  
  if (!amount || isNaN(amount) || amount <= 0) {
    logger.warn('Invalid amount for withdrawal', { 
      amount, 
      accountNumber, 
      requestId: req.requestId 
    });
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  try {
    // Call transaction service
    const response = await axios.post('http://transaction-service:3004/api/transactions', {
      type: 'withdrawal',
      sourceAccountNumber: accountNumber,
      amount
    }, {
      headers: {
        'X-Session-ID': req.sessionId,
        'X-Request-ID': req.requestId
      }
    });
    
    logger.info('Withdrawal processed', { 
      accountNumber, 
      amount, 
      transactionId: response.data.transaction.id,
      requestId: req.requestId 
    });
    
    res.status(200).json(response.data);
  } catch (error) {
    logger.error('Failed to process withdrawal', { 
      error: error.message, 
      stack: error.stack, 
      accountNumber, 
      amount, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'withdrawal' });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

// Make transfer (forward to transaction service)
app.post('/api/accounts/:accountNumber/transfer', async (req, res) => {
  const { destinationAccount, amount } = req.body;
  const { accountNumber } = req.params;
  
  if (!amount || isNaN(amount) || amount <= 0) {
    logger.warn('Invalid amount for transfer', { 
      amount, 
      accountNumber,
      destinationAccount,
      requestId: req.requestId 
    });
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  if (!destinationAccount) {
    logger.warn('Missing destination account for transfer', { 
      accountNumber,
      requestId: req.requestId 
    });
    return res.status(400).json({ error: 'Destination account is required' });
  }
  
  try {
    // Call transaction service
    const response = await axios.post('http://transaction-service:3004/api/transactions', {
      type: 'transfer',
      sourceAccountNumber: accountNumber,
      targetAccountNumber: destinationAccount,
      amount
    }, {
      headers: {
        'X-Session-ID': req.sessionId,
        'X-Request-ID': req.requestId
      }
    });
    
    logger.info('Transfer processed', { 
      sourceAccount: accountNumber, 
      destinationAccount,
      amount, 
      transactionId: response.data.transaction.id,
      requestId: req.requestId 
    });
    
    res.status(200).json(response.data);
  } catch (error) {
    logger.error('Failed to process transfer', { 
      error: error.message, 
      stack: error.stack, 
      sourceAccount: accountNumber, 
      destinationAccount,
      amount, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'transfer' });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({ error: 'Failed to process transfer' });
  }
});

// Get transaction history (forward to transaction service)
app.get('/api/accounts/:accountNumber/transactions', async (req, res) => {
  const { accountNumber } = req.params;
  
  try {
    // Call transaction service
    const response = await axios.get(`http://transaction-service:3004/api/accounts/${accountNumber}/transactions`, {
      headers: {
        'X-Session-ID': req.sessionId,
        'X-Request-ID': req.requestId
      }
    });
    
    logger.info('Transaction history retrieved', { 
      accountNumber,
      count: response.data.transactions?.length || 0,
      requestId: req.requestId 
    });
    
    res.status(200).json(response.data);
  } catch (error) {
    logger.error('Failed to retrieve transaction history', { 
      error: error.message, 
      stack: error.stack, 
      accountNumber, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'getTransactionHistory' });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({ error: 'Failed to retrieve transaction history' });
  }
});

// Get customer profile with accounts (forwards to customer service)
app.get('/api/customers/:id/profile', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Call customer service
    const response = await axios.get(`http://customer-service:3003/api/customers/${id}/profile`, {
      headers: {
        'X-Session-ID': req.sessionId,
        'X-Request-ID': req.requestId
      }
    });
    
    logger.info('Customer profile retrieved', { 
      customerId: id,
      requestId: req.requestId 
    });
    
    res.status(200).json(response.data);
  } catch (error) {
    logger.error('Failed to retrieve customer profile', { 
      error: error.message, 
      stack: error.stack, 
      customerId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'customer-api', operation: 'getCustomerProfile' });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({ error: 'Failed to retrieve customer profile' });
  }
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Customer API Service running on port ${PORT}`, { environment: 'cloud' });
}); 