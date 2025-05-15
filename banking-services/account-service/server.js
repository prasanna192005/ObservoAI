/*server.js - Account Service (Hybrid Environment)*/
// Import telemetry first for proper instrumentation
const { initTelemetry } = require('../telemetry');
const { logger, metrics } = initTelemetry('account-service', 'hybrid');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { accountOperations, customerOperations } = require('../database');
const { createTelemetryMiddleware } = require('../middleware/telemetry-middleware');

// Constants
const PORT = 3002;
const app = express();
const CUSTOMER_SERVICE_URL = process.env.CUSTOMER_SERVICE_URL || 'http://localhost:3003';

// Store environment and service name for context
app.set('environment', 'hybrid');
app.set('serviceName', 'account-service');

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Add anomaly detection telemetry middleware
app.use(createTelemetryMiddleware(metrics));

// Request tracking middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  // Get request and session IDs from headers if present (propagated from API Gateway)
  const requestId = req.headers['x-request-id'] || uuidv4();
  const sessionId = req.headers['x-session-id'] || uuidv4();

  // Add trace context to logs
  logger.info('Request received', {
    requestId,
    sessionId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    environment: 'hybrid'
  });

  // Track request with metrics
  metrics.requestCounter.add(1, {
    service: 'account-service',
    method: req.method,
    path: req.path,
    environment: 'hybrid'
  });

  // Add trace context to response headers
  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000; // seconds
    metrics.requestDurationHistogram.record(duration, {
      service: 'account-service',
      method: req.method,
      path: req.path,
      status_code: res.statusCode.toString(),
      environment: 'hybrid'
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

  // Add session and request ID to request object
  req.sessionId = sessionId;
  req.requestId = requestId;
  res.setHeader('X-Session-ID', sessionId);
  res.setHeader('X-Request-ID', requestId);

  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'account-service', environment: 'hybrid' });
});

// Get all accounts
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = accountOperations.getAccounts();
    
    logger.info('All accounts retrieved', { 
      count: accounts.length,
      requestId: req.requestId 
    });
    
    res.json(accounts);
  } catch (error) {
    logger.error('Failed to get accounts', { 
      error: error.message, 
      stack: error.stack, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'account-service', operation: 'getAccounts' });
    res.status(500).json({ error: 'Failed to get accounts' });
  }
});

// Get account by account number
app.get('/api/accounts/:accountNumber', (req, res) => {
  const { accountNumber } = req.params;
  
  try {
    const account = accountOperations.getAccountByNumber(accountNumber);
    
    if (!account) {
      logger.warn('Account not found', { accountNumber, requestId: req.requestId });
      return res.status(404).json({ error: 'Account not found' });
    }
    
    logger.info('Account retrieved', { accountNumber, requestId: req.requestId });
    res.json(account);
  } catch (error) {
    logger.error('Failed to get account', { 
      error: error.message, 
      stack: error.stack, 
      accountNumber, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'account-service', operation: 'getAccount' });
    res.status(500).json({ error: 'Failed to get account' });
  }
});

// Create a new account
app.post('/api/accounts', async (req, res) => {
  const { customerId, type, initialDeposit = 0 } = req.body;
  
  // Validate required fields
  if (!customerId) {
    logger.warn('Missing customerId', { requestId: req.requestId });
    return res.status(400).json({ error: 'Customer ID is required' });
  }
  
  if (!type) {
    logger.warn('Missing account type', { customerId, requestId: req.requestId });
    return res.status(400).json({ error: 'Account type is required' });
  }
  
  // Validate account type
  if (!['checking', 'savings', 'investment'].includes(type)) {
    logger.warn('Invalid account type', { type, customerId, requestId: req.requestId });
    return res.status(400).json({ error: 'Account type must be checking, savings, or investment' });
  }
  
  // Validate initial deposit
  if (initialDeposit < 0) {
    logger.warn('Negative initial deposit', { initialDeposit, customerId, requestId: req.requestId });
    return res.status(400).json({ error: 'Initial deposit cannot be negative' });
  }
  
  try {
    // Check if customer exists using the customer service
    const startTime = Date.now();
    let customerExists = false;
    
    // For hybrid environment, we support both direct DB lookup and service call
    // Try direct lookup first (on-premises approach)
    try {
      const customer = customerOperations.getCustomerById(customerId);
      customerExists = !!customer;
      
      logger.info('Customer validation via direct DB lookup', {
        customerId,
        exists: customerExists,
        requestId: req.requestId
      });
    } catch (dbError) {
      logger.warn('Direct DB lookup failed, falling back to service call', {
        error: dbError.message,
        customerId,
        requestId: req.requestId
      });
      
      // If direct lookup fails, fall back to service call (cloud approach)
      try {
        const response = await axios.get(`${CUSTOMER_SERVICE_URL}/api/customers/${customerId}`, {
          headers: {
            'X-Request-ID': req.requestId,
            'X-Session-ID': req.sessionId,
            'X-Source-Service': 'account-service',
            'X-Source-Environment': 'hybrid'
          }
        });
        
        customerExists = response.status === 200;
        
        const latency = Date.now() - startTime;
        
        metrics.serviceCallDurationHistogram.record(latency / 1000, {
          service: 'account-service',
          target_service: 'customer-service',
          operation: 'getCustomer',
          environment: 'hybrid'
        });
        
        logger.info('Customer validation via service call', {
          customerId,
          exists: customerExists,
          latencyMs: latency,
          requestId: req.requestId
        });
      } catch (serviceError) {
        // Record the failed service call
        metrics.serviceCallErrorCounter.add(1, {
          service: 'account-service',
          target_service: 'customer-service',
          operation: 'getCustomer',
          environment: 'hybrid'
        });
        
        logger.error('Customer service validation failed', {
          error: serviceError.message,
          statusCode: serviceError.response?.status,
          customerId,
          requestId: req.requestId
        });
        
        return res.status(500).json({ error: 'Failed to validate customer' });
      }
    }
    
    if (!customerExists) {
      logger.warn('Customer not found', { customerId, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Generate unique account number (in production, would use a more secure method)
    const accountNumber = `ACC${Math.floor(100000000 + Math.random() * 900000000)}`;
    
    // Create the account
    const account = accountOperations.createAccount({
      accountNumber,
      customerId,
      type,
      balance: initialDeposit,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    
    // Record metrics for account creation
    metrics.accountCounter.add(1, {
      service: 'account-service',
      type,
      environment: 'hybrid'
    });
    
    logger.info('Account created', {
      accountNumber,
      customerId,
      type,
      initialDeposit,
      requestId: req.requestId
    });
    
    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      account
    });
  } catch (error) {
    logger.error('Failed to create account', {
      error: error.message,
      stack: error.stack,
      customerId,
      type,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'createAccount',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Update account status (activate, suspend, close)
app.patch('/api/accounts/:accountNumber/status', (req, res) => {
  const { accountNumber } = req.params;
  const { status } = req.body;
  
  // Validate status
  if (!status || !['active', 'suspended', 'closed'].includes(status)) {
    logger.warn('Invalid status update', { accountNumber, status, requestId: req.requestId });
    return res.status(400).json({ error: 'Status must be active, suspended, or closed' });
  }
  
  try {
    // Check if account exists
    const account = accountOperations.getAccountByNumber(accountNumber);
    
    if (!account) {
      logger.warn('Account not found for status update', { accountNumber, requestId: req.requestId });
      return res.status(404).json({ error: 'Account not found' });
    }
    
    // Update account status
    const updatedAccount = accountOperations.updateAccountStatus(accountNumber, status);
    
    logger.info('Account status updated', {
      accountNumber,
      previousStatus: account.status,
      newStatus: status,
      requestId: req.requestId
    });
    
    // Record status change metrics
    metrics.accountStatusChangeCounter.add(1, {
      service: 'account-service',
      previousStatus: account.status,
      newStatus: status,
      environment: 'hybrid'
    });
    
    res.json({
      success: true,
      message: 'Account status updated successfully',
      account: updatedAccount
    });
  } catch (error) {
    logger.error('Failed to update account status', {
      error: error.message,
      stack: error.stack,
      accountNumber,
      status,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'updateAccountStatus',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Failed to update account status' });
  }
});

// Get accounts by customer ID
app.get('/api/customers/:customerId/accounts', (req, res) => {
  const { customerId } = req.params;
  
  try {
    // First check if customer exists
    let customerExists = false;
    
    // In hybrid environment, check local DB first
    try {
      const customer = customerOperations.getCustomerById(customerId);
      customerExists = !!customer;
    } catch (dbError) {
      // If direct lookup fails, assume customer exists and continue
      // In a real app, we might want to verify with the customer service
      logger.warn('Customer DB lookup failed, assuming customer exists', {
        error: dbError.message,
        customerId,
        requestId: req.requestId
      });
      customerExists = true;
    }
    
    if (!customerExists) {
      logger.warn('Customer not found for accounts lookup', { customerId, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Get customer accounts
    const accounts = accountOperations.getAccountsByCustomerId(customerId);
    
    logger.info('Customer accounts retrieved', {
      customerId,
      count: accounts.length,
      requestId: req.requestId
    });
    
    res.json(accounts);
  } catch (error) {
    logger.error('Failed to get customer accounts', {
      error: error.message,
      stack: error.stack,
      customerId,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'getCustomerAccounts',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Failed to get customer accounts' });
  }
});

// Get account balance
app.get('/api/accounts/:accountNumber/balance', (req, res) => {
  const { accountNumber } = req.params;
  
  try {
    const account = accountOperations.getAccountByNumber(accountNumber);
    
    if (!account) {
      logger.warn('Account not found for balance check', { accountNumber, requestId: req.requestId });
      return res.status(404).json({ error: 'Account not found' });
    }
    
    logger.info('Account balance retrieved', {
      accountNumber,
      balance: account.balance,
      requestId: req.requestId
    });
    
    res.json({
      accountNumber: account.accountNumber,
      balance: account.balance,
      currency: 'USD', // Assume USD for simplicity
      lastUpdated: account.updatedAt
    });
  } catch (error) {
    logger.error('Failed to get account balance', {
      error: error.message,
      stack: error.stack,
      accountNumber,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'getAccountBalance',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Failed to get account balance' });
  }
});

// Transfer between accounts (internal account transfers)
app.post('/api/accounts/transfer', (req, res) => {
  const { sourceAccountNumber, targetAccountNumber, amount } = req.body;
  
  // Validate required fields
  if (!sourceAccountNumber || !targetAccountNumber) {
    logger.warn('Missing account numbers for transfer', {
      sourceAccountNumber,
      targetAccountNumber,
      requestId: req.requestId
    });
    return res.status(400).json({ error: 'Source and target account numbers are required' });
  }
  
  // Validate amount
  if (!amount || isNaN(amount) || amount <= 0) {
    logger.warn('Invalid transfer amount', { amount, requestId: req.requestId });
    return res.status(400).json({ error: 'Transfer amount must be a positive number' });
  }
  
  // Ensure accounts are different
  if (sourceAccountNumber === targetAccountNumber) {
    logger.warn('Source and target accounts are the same', {
      sourceAccountNumber,
      requestId: req.requestId
    });
    return res.status(400).json({ error: 'Source and target accounts cannot be the same' });
  }
  
  try {
    // Start transaction processing time measurement
    const processingStartTime = Date.now();
    
    // Check if both accounts exist and are active
    const sourceAccount = accountOperations.getAccountByNumber(sourceAccountNumber);
    if (!sourceAccount) {
      logger.warn('Source account not found', { sourceAccountNumber, requestId: req.requestId });
      return res.status(404).json({ error: 'Source account not found' });
    }
    
    if (sourceAccount.status !== 'active') {
      logger.warn('Source account not active', {
        sourceAccountNumber,
        status: sourceAccount.status,
        requestId: req.requestId
      });
      return res.status(400).json({ error: 'Source account is not active' });
    }
    
    const targetAccount = accountOperations.getAccountByNumber(targetAccountNumber);
    if (!targetAccount) {
      logger.warn('Target account not found', { targetAccountNumber, requestId: req.requestId });
      return res.status(404).json({ error: 'Target account not found' });
    }
    
    if (targetAccount.status !== 'active') {
      logger.warn('Target account not active', {
        targetAccountNumber,
        status: targetAccount.status,
        requestId: req.requestId
      });
      return res.status(400).json({ error: 'Target account is not active' });
    }
    
    // Check if source account has sufficient funds
    if (sourceAccount.balance < amount) {
      logger.warn('Insufficient funds for transfer', {
        sourceAccountNumber,
        balance: sourceAccount.balance,
        requestedAmount: amount,
        requestId: req.requestId
      });
      
      // Record insufficient funds metric
      metrics.insufficientFundsCounter.add(1, {
        service: 'account-service',
        operation: 'transfer',
        environment: 'hybrid'
      });
      
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    
    // In hybrid environment, we use a mock transaction service call for audit
    // In a real system, we would use a proper transaction service
    
    // Deduct from source account
    const updatedSourceAccount = accountOperations.updateAccountBalance(
      sourceAccountNumber, 
      amount, 
      'subtract'
    );
    
    // Add to target account
    const updatedTargetAccount = accountOperations.updateAccountBalance(
      targetAccountNumber, 
      amount, 
      'add'
    );
    
    // Create transfer record internally
    const transferId = uuidv4();
    const transferTimestamp = new Date().toISOString();
    
    const transfer = {
      id: transferId,
      sourceAccountNumber,
      targetAccountNumber,
      amount,
      timestamp: transferTimestamp,
      status: 'completed',
      reference: `TRF-${transferId.slice(0, 8)}`,
      requestId: req.requestId
    };
    
    // End processing time measurement
    const processingTime = Date.now() - processingStartTime;
    
    // Record metrics
    metrics.transferProcessingTime.record(processingTime / 1000, {
      service: 'account-service',
      status: 'success',
      environment: 'hybrid'
    });
    
    metrics.transferCounter.add(1, {
      service: 'account-service',
      status: 'success',
      environment: 'hybrid'
    });
    
    metrics.transferAmountSum.record(amount, {
      service: 'account-service',
      environment: 'hybrid'
    });
    
    // Log successful transfer
    logger.info('Transfer completed successfully', {
      transferId,
      sourceAccountNumber,
      targetAccountNumber,
      amount,
      processingTimeMs: processingTime,
      requestId: req.requestId
    });
    
    // Return response with updated account balances
    res.status(200).json({
      success: true,
      message: 'Transfer completed successfully',
      transfer,
      sourceAccount: {
        accountNumber: sourceAccountNumber,
        newBalance: updatedSourceAccount.balance
      },
      targetAccount: {
        accountNumber: targetAccountNumber,
        newBalance: updatedTargetAccount.balance
      }
    });
  } catch (error) {
    logger.error('Transfer processing failed', {
      error: error.message,
      stack: error.stack,
      sourceAccountNumber,
      targetAccountNumber,
      amount,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'transfer',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Transfer processing failed' });
  }
});

// Get account statistics (count by type, status, etc.)
app.get('/api/accounts/statistics', (req, res) => {
  try {
    // Get account statistics
    const statistics = accountOperations.getAccountStatistics();
    
    logger.info('Account statistics retrieved', { requestId: req.requestId });
    
    res.json(statistics);
  } catch (error) {
    logger.error('Failed to get account statistics', {
      error: error.message,
      stack: error.stack,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'getAccountStatistics',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Failed to get account statistics' });
  }
});

// Search accounts
app.get('/api/accounts/search', (req, res) => {
  const { query, type, status, minBalance, maxBalance } = req.query;
  
  try {
    // Parse search criteria
    const searchCriteria = {
      query: query || '',
      type: type || '',
      status: status || '',
      minBalance: minBalance ? parseFloat(minBalance) : undefined,
      maxBalance: maxBalance ? parseFloat(maxBalance) : undefined
    };
    
    // Search accounts
    const accounts = accountOperations.searchAccounts(searchCriteria);
    
    logger.info('Accounts search performed', {
      criteria: searchCriteria,
      resultCount: accounts.length,
      requestId: req.requestId
    });
    
    res.json(accounts);
  } catch (error) {
    logger.error('Failed to search accounts', {
      error: error.message,
      stack: error.stack,
      query: req.query,
      requestId: req.requestId
    });
    
    metrics.errorCounter.add(1, {
      service: 'account-service',
      operation: 'searchAccounts',
      environment: 'hybrid'
    });
    
    res.status(500).json({ error: 'Failed to search accounts' });
  }
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Account Service running on port ${PORT}`, { environment: 'hybrid' });
}); 