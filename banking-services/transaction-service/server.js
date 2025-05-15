/*server.js - Transaction Service (On-Premises Environment)*/
// Import telemetry first for proper instrumentation
const { initTelemetry } = require('../telemetry');
const { logger, metrics } = initTelemetry('transaction-service', 'on-premises');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { transactionOperations, accountOperations } = require('../database');
const { createTelemetryMiddleware } = require('../middleware/telemetry-middleware');

// Constants
const PORT = 3004;
const app = express();
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3002';

// Store environment and service name for context
app.set('environment', 'on-premises');
app.set('serviceName', 'transaction-service');

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
    environment: 'on-premises'
  });

  // Track request with metrics
  metrics.requestCounter.add(1, {
    service: 'transaction-service',
    method: req.method,
    path: req.path,
    environment: 'on-premises'
  });

  // Add trace context to response headers
  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000; // seconds
    metrics.requestDurationHistogram.record(duration, {
      service: 'transaction-service',
      method: req.method,
      path: req.path,
      status_code: res.statusCode.toString(),
      environment: 'on-premises'
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
  res.status(200).json({ status: 'ok', service: 'transaction-service', environment: 'on-premises' });
});

// Create a new transaction (deposit, withdrawal, transfer)
app.post('/api/transactions', async (req, res) => {
  const { type, sourceAccountNumber, targetAccountNumber, amount, description } = req.body;
  
  // Validate transaction type
  if (!['deposit', 'withdrawal', 'transfer'].includes(type)) {
    logger.warn('Invalid transaction type', { type, requestId: req.requestId });
    return res.status(400).json({ error: 'Transaction type must be deposit, withdrawal, or transfer' });
  }
  
  // Validate amount
  if (!amount || isNaN(amount) || amount <= 0) {
    logger.warn('Invalid transaction amount', { amount, requestId: req.requestId });
    return res.status(400).json({ error: 'Transaction amount must be a positive number' });
  }
  
  // Validate accounts based on transaction type
  if ((type === 'withdrawal' || type === 'transfer') && !sourceAccountNumber) {
    logger.warn('Missing source account', { type, requestId: req.requestId });
    return res.status(400).json({ error: 'Source account number is required' });
  }
  
  if (type === 'transfer' && !targetAccountNumber) {
    logger.warn('Missing target account', { type, requestId: req.requestId });
    return res.status(400).json({ error: 'Target account number is required for transfers' });
  }

  if (type === 'deposit' && !targetAccountNumber) {
    logger.warn('Missing target account', { type, requestId: req.requestId });
    return res.status(400).json({ error: 'Target account number is required for deposits' });
  }
  
  try {
    // For transfers, check that source and target accounts are different
    if (type === 'transfer' && sourceAccountNumber === targetAccountNumber) {
      logger.warn('Source and target accounts are the same', { 
        sourceAccountNumber, 
        requestId: req.requestId 
      });
      return res.status(400).json({ error: 'Source and target accounts cannot be the same' });
    }
    
    // Prepare transaction data with new transaction ID
    const transactionId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // For on-premises environment, we directly validate and update account balances
    // In a real application, these should be done within a proper database transaction
    
    // Verify accounts and balances
    if (type === 'withdrawal' || type === 'transfer') {
      // Check source account
      const sourceAccount = accountOperations.getAccountByNumber(sourceAccountNumber);
      
      if (!sourceAccount) {
        logger.warn('Source account not found', { 
          sourceAccountNumber, 
          requestId: req.requestId 
        });
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
      
      if (sourceAccount.balance < amount) {
        logger.warn('Insufficient funds', { 
          sourceAccountNumber, 
          balance: sourceAccount.balance,
          requestedAmount: amount,
          requestId: req.requestId 
        });
        return res.status(400).json({ error: 'Insufficient funds' });
      }
    }
    
    if (type === 'deposit' || type === 'transfer') {
      // Check target account
      const targetAccount = accountOperations.getAccountByNumber(targetAccountNumber);
      
      if (!targetAccount) {
        logger.warn('Target account not found', { 
          targetAccountNumber, 
          requestId: req.requestId 
        });
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
    }
    
    // Start a timer to measure processing time for metrics
    const processingStartTime = Date.now();
    
    // Process transaction based on type
    let transaction;
    
    switch (type) {
      case 'deposit':
        // Update target account balance
        accountOperations.updateAccountBalance(targetAccountNumber, amount, 'add');
        
        // Create transaction record
        transaction = transactionOperations.createTransaction({
          id: transactionId,
          type,
          amount,
          sourceAccountNumber: null,
          targetAccountNumber,
          description: description || 'Deposit',
          timestamp,
          status: 'completed',
          requestId: req.requestId
        });
        break;
        
      case 'withdrawal':
        // Update source account balance
        accountOperations.updateAccountBalance(sourceAccountNumber, amount, 'subtract');
        
        // Create transaction record
        transaction = transactionOperations.createTransaction({
          id: transactionId,
          type,
          amount,
          sourceAccountNumber,
          targetAccountNumber: null,
          description: description || 'Withdrawal',
          timestamp,
          status: 'completed',
          requestId: req.requestId
        });
        break;
        
      case 'transfer':
        // Update source account balance (subtract)
        accountOperations.updateAccountBalance(sourceAccountNumber, amount, 'subtract');
        
        // Update target account balance (add)
        accountOperations.updateAccountBalance(targetAccountNumber, amount, 'add');
        
        // Create transaction record
        transaction = transactionOperations.createTransaction({
          id: transactionId,
          type,
          amount,
          sourceAccountNumber,
          targetAccountNumber,
          description: description || 'Transfer',
          timestamp,
          status: 'completed',
          requestId: req.requestId
        });
        break;
    }
    
    // Record metrics
    const processingTime = Date.now() - processingStartTime;
    
    metrics.transactionProcessingTime.record(processingTime / 1000, {
      service: 'transaction-service',
      type,
      status: 'success',
      environment: 'on-premises'
    });
    
    metrics.transactionCounter.add(1, {
      service: 'transaction-service',
      type,
      status: 'success',
      environment: 'on-premises'
    });
    
    metrics.transactionAmountSum.record(amount, {
      service: 'transaction-service',
      type,
      environment: 'on-premises'
    });
    
    logger.info('Transaction completed successfully', { 
      transactionId,
      type,
      amount,
      sourceAccountNumber,
      targetAccountNumber,
      processingTimeMs: processingTime,
      requestId: req.requestId 
    });
    
    res.status(201).json({
      success: true,
      message: 'Transaction completed successfully',
      transaction
    });
  } catch (error) {
    logger.error('Transaction processing failed', { 
      error: error.message, 
      stack: error.stack, 
      type, 
      amount,
      sourceAccountNumber,
      targetAccountNumber,
      requestId: req.requestId 
    });
    
    metrics.errorCounter.add(1, { 
      service: 'transaction-service', 
      operation: 'processTransaction',
      type,
      environment: 'on-premises'
    });
    
    res.status(500).json({ error: 'Transaction processing failed' });
  }
});

// Get transaction by ID
app.get('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  
  try {
    const transaction = transactionOperations.getTransactionById(id);
    
    if (!transaction) {
      logger.warn('Transaction not found', { transactionId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    logger.info('Transaction retrieved', { 
      transactionId: id,
      requestId: req.requestId 
    });
    
    res.json(transaction);
  } catch (error) {
    logger.error('Failed to get transaction', { 
      error: error.message, 
      stack: error.stack, 
      transactionId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'transaction-service', operation: 'getTransaction' });
    res.status(500).json({ error: 'Failed to get transaction' });
  }
});

// Get account transactions
app.get('/api/accounts/:accountNumber/transactions', (req, res) => {
  const { accountNumber } = req.params;
  const { startDate, endDate, type, limit = 10, page = 1 } = req.query;
  
  try {
    // Verify account exists
    const account = accountOperations.getAccountByNumber(accountNumber);
    if (!account) {
      logger.warn('Account not found for transaction history', { 
        accountNumber, 
        requestId: req.requestId 
      });
      return res.status(404).json({ error: 'Account not found' });
    }
    
    // Parse query parameters
    const filters = {
      accountNumber,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      type: type || undefined
    };
    
    // Parse pagination parameters
    const pagination = {
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };
    
    // Get transactions with filtering and pagination
    const { transactions, total } = transactionOperations.getAccountTransactions(
      filters,
      pagination
    );
    
    logger.info('Account transactions retrieved', { 
      accountNumber,
      count: transactions.length,
      total,
      filters: Object.entries(filters)
        .filter(([_, value]) => value !== undefined)
        .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {}),
      pagination,
      requestId: req.requestId 
    });
    
    // Return paginated result with metadata
    res.json({
      transactions,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Failed to get account transactions', { 
      error: error.message, 
      stack: error.stack, 
      accountNumber, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'transaction-service', operation: 'getAccountTransactions' });
    res.status(500).json({ error: 'Failed to get account transactions' });
  }
});

// Get customer transactions (across all accounts)
app.get('/api/customers/:customerId/transactions', async (req, res) => {
  const { customerId } = req.params;
  const { startDate, endDate, type, limit = 10, page = 1 } = req.query;
  
  try {
    // Get the customer's accounts from account service
    const startTime = Date.now();
    
    try {
      // Get the customer's accounts first
      const accountsResponse = await axios.get(`${ACCOUNT_SERVICE_URL}/api/customers/${customerId}/accounts`, {
        headers: {
          'X-Request-ID': req.requestId,
          'X-Session-ID': req.sessionId,
          'X-Source-Service': 'transaction-service',
          'X-Source-Environment': 'on-premises'
        }
      });
      
      const accounts = accountsResponse.data;
      const latency = Date.now() - startTime;
      
      // Record the service call metrics
      metrics.serviceCallDurationHistogram.record(latency / 1000, {
        service: 'transaction-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'on-premises'
      });
      
      if (!accounts || accounts.length === 0) {
        logger.info('No accounts found for customer', { 
          customerId,
          requestId: req.requestId 
        });
        
        // Return empty result with pagination
        return res.json({
          transactions: [],
          pagination: {
            total: 0,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: 0
          }
        });
      }
      
      // Get account numbers
      const accountNumbers = accounts.map(account => account.accountNumber);
      
      // Parse query parameters
      const filters = {
        accountNumbers,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        type: type || undefined
      };
      
      // Parse pagination parameters
      const pagination = {
        limit: parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit)
      };
      
      // Get transactions with filtering and pagination
      const { transactions, total } = transactionOperations.getCustomerTransactions(
        filters,
        pagination
      );
      
      logger.info('Customer transactions retrieved', { 
        customerId,
        accountCount: accountNumbers.length,
        transactionCount: transactions.length,
        total,
        filters: Object.entries(filters)
          .filter(([key, value]) => key !== 'accountNumbers' && value !== undefined)
          .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {}),
        pagination,
        requestId: req.requestId 
      });
      
      // Return paginated result with metadata
      res.json({
        transactions,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        }
      });
    } catch (axiosError) {
      // Record the failed service call
      metrics.serviceCallErrorCounter.add(1, {
        service: 'transaction-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'on-premises'
      });
      
      logger.error('Account service call failed for retrieving customer accounts', { 
        error: axiosError.message, 
        statusCode: axiosError.response?.status,
        customerId, 
        requestId: req.requestId 
      });
      
      res.status(500).json({ error: 'Failed to retrieve customer accounts' });
    }
  } catch (error) {
    logger.error('Failed to get customer transactions', { 
      error: error.message, 
      stack: error.stack, 
      customerId, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'transaction-service', operation: 'getCustomerTransactions' });
    res.status(500).json({ error: 'Failed to get customer transactions' });
  }
});

// Get transaction statistics
app.get('/api/transactions/statistics', (req, res) => {
  const { period = 'day' } = req.query;
  
  try {
    // Validate period
    if (!['day', 'week', 'month'].includes(period)) {
      logger.warn('Invalid statistics period', { period, requestId: req.requestId });
      return res.status(400).json({ error: 'Period must be day, week, or month' });
    }
    
    // Calculate statistics
    const statistics = transactionOperations.getTransactionStatistics(period);
    
    logger.info('Transaction statistics retrieved', { 
      period,
      requestId: req.requestId 
    });
    
    res.json(statistics);
  } catch (error) {
    logger.error('Failed to get transaction statistics', { 
      error: error.message, 
      stack: error.stack, 
      period: req.query.period, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'transaction-service', operation: 'getTransactionStatistics' });
    res.status(500).json({ error: 'Failed to get transaction statistics' });
  }
});

// Verify transaction (for external reconciliation)
app.get('/api/transactions/:id/verify', (req, res) => {
  const { id } = req.params;
  
  try {
    const verificationResult = transactionOperations.verifyTransaction(id);
    
    if (!verificationResult.transaction) {
      logger.warn('Transaction not found for verification', { transactionId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    logger.info('Transaction verified', { 
      transactionId: id,
      verified: verificationResult.verified,
      requestId: req.requestId 
    });
    
    res.json(verificationResult);
  } catch (error) {
    logger.error('Failed to verify transaction', { 
      error: error.message, 
      stack: error.stack, 
      transactionId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { service: 'transaction-service', operation: 'verifyTransaction' });
    res.status(500).json({ error: 'Failed to verify transaction' });
  }
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Transaction Service running on port ${PORT}`, { environment: 'on-premises' });
}); 