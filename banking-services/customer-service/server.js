/*server.js - Customer Service (Cloud Environment)*/
// Import telemetry first for proper instrumentation
const { initTelemetry } = require('../telemetry');
const { logger, metrics } = initTelemetry('customer-service', 'cloud');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { customerOperations } = require('../database');
const { createTelemetryMiddleware } = require('../middleware/telemetry-middleware');

// Constants
const PORT = 3003;
const app = express();
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3002';

// Store environment and service name for context
app.set('environment', 'cloud');
app.set('serviceName', 'customer-service');

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
    userAgent: req.headers['user-agent']
  });

  // Track request with metrics
  metrics.requestCounter.add(1, {
    service: 'customer-service',
    method: req.method,
    path: req.path,
    environment: 'cloud'
  });

  // Add trace context to response headers
  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000; // seconds
    metrics.requestDurationHistogram.record(duration, {
      service: 'customer-service',
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
  res.status(200).json({ status: 'ok', service: 'customer-service', environment: 'cloud' });
});

// Get all customers
app.get('/api/customers', (req, res) => {
  try {
    const customers = customerOperations.getCustomers();
    
    logger.info('Retrieved all customers', { 
      count: customers.length,
      requestId: req.requestId 
    });
    
    res.json(customers);
  } catch (error) {
    logger.error('Failed to get customers', { 
      error: error.message, 
      stack: error.stack, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'getCustomers' 
    });
    res.status(500).json({ error: 'Failed to get customers' });
  }
});

// Get customer by ID
app.get('/api/customers/:id', (req, res) => {
  try {
    const customer = customerOperations.getCustomerById(req.params.id);
    if (!customer) {
      logger.warn('Customer not found', { customerId: req.params.id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    logger.info('Retrieved customer', { 
      customerId: req.params.id,
      requestId: req.requestId 
    });
    
    res.json(customer);
  } catch (error) {
    logger.error('Failed to get customer', { 
      error: error.message, 
      stack: error.stack, 
      customerId: req.params.id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'getCustomer' 
    });
    res.status(500).json({ error: 'Failed to get customer' });
  }
});

// Create new customer
app.post('/api/customers', (req, res) => {
  const { firstName, lastName, email, phoneNumber, address } = req.body;
  
  if (!firstName || !lastName || !email) {
    logger.warn('Invalid customer creation request', { 
      firstName, lastName, email, 
      requestId: req.requestId 
    });
    return res.status(400).json({ error: 'First name, last name, and email are required' });
  }
  
  try {
    // Check for existing customer with same email
    const existingCustomer = customerOperations.getCustomerByEmail(email);
    if (existingCustomer) {
      logger.warn('Customer with email already exists', { 
        email,
        existingCustomerId: existingCustomer.id,
        requestId: req.requestId 
      });
      return res.status(409).json({ error: 'Customer with this email already exists' });
    }
    
    const customer = customerOperations.createCustomer({
      firstName,
      lastName,
      email,
      phoneNumber,
      address,
      requestId: req.requestId
    });
    
    // Record metrics for customer creation
    metrics.customerCreationCounter.add(1, { 
      service: 'customer-service',
      environment: 'cloud'
    });
    
    logger.info('Customer created successfully', { 
      customerId: customer.id,
      email,
      requestId: req.requestId 
    });
    
    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      customer
    });
  } catch (error) {
    logger.error('Failed to create customer', { 
      error: error.message, 
      stack: error.stack, 
      email, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'createCustomer' 
    });
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// Update customer
app.put('/api/customers/:id', (req, res) => {
  const { id } = req.params;
  const { firstName, lastName, email, phoneNumber, address } = req.body;
  
  if (!firstName && !lastName && !email && !phoneNumber && !address) {
    logger.warn('Empty customer update request', { customerId: id, requestId: req.requestId });
    return res.status(400).json({ error: 'At least one field is required for update' });
  }
  
  try {
    // Check if customer exists
    const existingCustomer = customerOperations.getCustomerById(id);
    if (!existingCustomer) {
      logger.warn('Customer not found for update', { customerId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // If email is being updated, check that it's not already in use
    if (email && email !== existingCustomer.email) {
      const customerWithEmail = customerOperations.getCustomerByEmail(email);
      if (customerWithEmail && customerWithEmail.id !== id) {
        logger.warn('Email already in use by another customer', { 
          email, 
          conflictingCustomerId: customerWithEmail.id,
          requestId: req.requestId 
        });
        return res.status(409).json({ error: 'Email already in use by another customer' });
      }
    }
    
    const updatedCustomer = customerOperations.updateCustomer(id, {
      firstName,
      lastName,
      email,
      phoneNumber,
      address,
      requestId: req.requestId
    });
    
    logger.info('Customer updated successfully', { 
      customerId: id,
      updatedFields: Object.keys(req.body).filter(key => req.body[key] !== undefined),
      requestId: req.requestId 
    });
    
    res.json({
      success: true,
      message: 'Customer updated successfully',
      customer: updatedCustomer
    });
  } catch (error) {
    logger.error('Failed to update customer', { 
      error: error.message, 
      stack: error.stack, 
      customerId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'updateCustomer' 
    });
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// Delete customer
app.delete('/api/customers/:id', (req, res) => {
  const { id } = req.params;
  
  try {
    // Check if customer exists
    const existingCustomer = customerOperations.getCustomerById(id);
    if (!existingCustomer) {
      logger.warn('Customer not found for deletion', { customerId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Check if customer has any accounts (call to account service)
    const startTime = Date.now();
    
    axios.get(`${ACCOUNT_SERVICE_URL}/api/customers/${id}/accounts`, {
      headers: {
        'X-Request-ID': req.requestId,
        'X-Session-ID': req.sessionId,
        'X-Source-Service': 'customer-service',
        'X-Source-Environment': 'cloud'
      }
    })
    .then(response => {
      const accounts = response.data;
      const latency = Date.now() - startTime;
      
      // Record the service call metrics
      metrics.serviceCallDurationHistogram.record(latency / 1000, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'cloud'
      });
      
      // If customer has accounts, don't allow deletion
      if (accounts && accounts.length > 0) {
        logger.warn('Cannot delete customer with active accounts', { 
          customerId: id, 
          accountCount: accounts.length,
          requestId: req.requestId 
        });
        return res.status(400).json({ 
          error: 'Cannot delete customer with active accounts. Close all accounts first.' 
        });
      }
      
      // Proceed with customer deletion
      customerOperations.deleteCustomer(id, req.requestId);
      
      logger.info('Customer deleted successfully', { 
        customerId: id,
        requestId: req.requestId 
      });
      
      res.json({
        success: true,
        message: 'Customer deleted successfully'
      });
    })
    .catch(error => {
      // Record the failed service call
      metrics.serviceCallErrorCounter.add(1, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'cloud'
      });
      
      logger.error('Account service call failed while attempting customer deletion', { 
        error: error.message, 
        customerId: id, 
        requestId: req.requestId 
      });
      
      // If we can't reach the account service, don't delete the customer for safety
      res.status(500).json({ 
        error: 'Unable to verify account status. Customer deletion aborted.' 
      });
    });
  } catch (error) {
    logger.error('Failed to delete customer', { 
      error: error.message, 
      stack: error.stack, 
      customerId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'deleteCustomer' 
    });
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// Get customer's accounts (fetch from account service)
app.get('/api/customers/:id/accounts', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Verify customer exists
    const customer = customerOperations.getCustomerById(id);
    if (!customer) {
      logger.warn('Customer not found for accounts lookup', { customerId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Forward to account service
    const startTime = Date.now();
    
    try {
      const response = await axios.get(`${ACCOUNT_SERVICE_URL}/api/customers/${id}/accounts`, {
        headers: {
          'X-Request-ID': req.requestId,
          'X-Session-ID': req.sessionId,
          'X-Source-Service': 'customer-service',
          'X-Source-Environment': 'cloud'
        }
      });
      
      const accounts = response.data;
      const latency = Date.now() - startTime;
      
      // Record the service call metrics
      metrics.serviceCallDurationHistogram.record(latency / 1000, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'cloud'
      });
      
      logger.info('Customer accounts retrieved from account service', { 
        customerId: id,
        accountCount: accounts.length,
        latency,
        requestId: req.requestId 
      });
      
      res.json(accounts);
    } catch (axiosError) {
      // Record the failed service call
      metrics.serviceCallErrorCounter.add(1, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'cloud'
      });
      
      const errorResponse = axiosError.response?.data || { error: 'Account service unavailable' };
      const statusCode = axiosError.response?.status || 500;
      
      logger.error('Account service call failed for retrieving customer accounts', { 
        error: axiosError.message, 
        statusCode,
        customerId: id, 
        requestId: req.requestId 
      });
      
      res.status(statusCode).json(errorResponse);
    }
  } catch (error) {
    logger.error('Failed to get customer accounts', { 
      error: error.message, 
      stack: error.stack, 
      customerId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'getCustomerAccounts' 
    });
    res.status(500).json({ error: 'Failed to get customer accounts' });
  }
});

// Create account for customer (forwards to account service)
app.post('/api/customers/:id/accounts', async (req, res) => {
  const { id } = req.params;
  const { accountType, initialDeposit } = req.body;
  
  if (!accountType) {
    logger.warn('Invalid account creation request', { 
      customerId: id, 
      accountType, 
      initialDeposit, 
      requestId: req.requestId 
    });
    return res.status(400).json({ error: 'Account type is required' });
  }
  
  try {
    // Verify customer exists
    const customer = customerOperations.getCustomerById(id);
    if (!customer) {
      logger.warn('Customer not found for account creation', { customerId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Forward to account service
    const startTime = Date.now();
    
    try {
      const response = await axios.post(`${ACCOUNT_SERVICE_URL}/api/accounts`, {
        customerId: id,
        accountType,
        initialDeposit
      }, {
        headers: {
          'X-Request-ID': req.requestId,
          'X-Session-ID': req.sessionId,
          'X-Source-Service': 'customer-service',
          'X-Source-Environment': 'cloud'
        }
      });
      
      const latency = Date.now() - startTime;
      
      // Record the service call metrics
      metrics.serviceCallDurationHistogram.record(latency / 1000, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'createAccount',
        environment: 'cloud'
      });
      
      logger.info('Account created for customer via account service', { 
        customerId: id,
        accountType,
        accountNumber: response.data.account?.accountNumber,
        latency,
        requestId: req.requestId 
      });
      
      res.status(201).json(response.data);
    } catch (axiosError) {
      // Record the failed service call
      metrics.serviceCallErrorCounter.add(1, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'createAccount',
        environment: 'cloud'
      });
      
      const errorResponse = axiosError.response?.data || { error: 'Account service unavailable' };
      const statusCode = axiosError.response?.status || 500;
      
      logger.error('Account service call failed for account creation', { 
        error: axiosError.message, 
        statusCode,
        customerId: id, 
        accountType, 
        initialDeposit, 
        requestId: req.requestId 
      });
      
      res.status(statusCode).json(errorResponse);
    }
  } catch (error) {
    logger.error('Failed to create account for customer', { 
      error: error.message, 
      stack: error.stack, 
      customerId: id, 
      accountType, 
      initialDeposit, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'createCustomerAccount' 
    });
    res.status(500).json({ error: 'Failed to create account for customer' });
  }
});

// Search customers
app.get('/api/customers/search', (req, res) => {
  const { term } = req.query;
  
  if (!term || term.trim().length < 3) {
    logger.warn('Invalid search term', { term, requestId: req.requestId });
    return res.status(400).json({ error: 'Search term must be at least 3 characters long' });
  }
  
  try {
    const results = customerOperations.searchCustomers(term);
    
    logger.info('Customer search completed', { 
      term,
      resultCount: results.length,
      requestId: req.requestId 
    });
    
    res.json(results);
  } catch (error) {
    logger.error('Failed to search customers', { 
      error: error.message, 
      stack: error.stack, 
      term, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'searchCustomers' 
    });
    res.status(500).json({ error: 'Failed to search customers' });
  }
});

// Get customer profile with accounts (aggregate data from multiple services)
app.get('/api/customers/:id/profile', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Get customer data
    const customer = customerOperations.getCustomerById(id);
    if (!customer) {
      logger.warn('Customer not found for profile', { customerId: id, requestId: req.requestId });
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Create profile object with customer data
    const profile = {
      customer,
      accounts: [],
      accountSummary: {
        totalAccounts: 0,
        totalBalance: 0,
        accountTypes: {}
      }
    };
    
    // Call account service to get accounts
    const startTime = Date.now();
    
    try {
      const accountsResponse = await axios.get(`${ACCOUNT_SERVICE_URL}/api/customers/${id}/accounts`, {
        headers: {
          'X-Request-ID': req.requestId,
          'X-Session-ID': req.sessionId
        }
      });
      
      const accounts = accountsResponse.data;
      const latency = Date.now() - startTime;
      
      // Record the service call metrics
      metrics.serviceCallDurationHistogram.record(latency / 1000, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'cloud'
      });
      
      // Add accounts to profile
      profile.accounts = accounts;
      profile.accountSummary.totalAccounts = accounts.length;
      
      // Calculate account summary statistics
      accounts.forEach(account => {
        profile.accountSummary.totalBalance += account.balance;
        
        // Count by account type
        if (!profile.accountSummary.accountTypes[account.accountType]) {
          profile.accountSummary.accountTypes[account.accountType] = {
            count: 0,
            totalBalance: 0
          };
        }
        
        profile.accountSummary.accountTypes[account.accountType].count += 1;
        profile.accountSummary.accountTypes[account.accountType].totalBalance += account.balance;
      });
      
      logger.info('Customer profile retrieved', { 
        customerId: id, 
        accountCount: accounts.length,
        requestId: req.requestId 
      });
      
      res.json(profile);
    } catch (axiosError) {
      // Record the failed service call
      metrics.serviceCallErrorCounter.add(1, {
        service: 'customer-service',
        target_service: 'account-service',
        operation: 'getCustomerAccounts',
        environment: 'cloud'
      });
      
      logger.error('Account service call failed for customer profile', { 
        error: axiosError.message, 
        customerId: id, 
        requestId: req.requestId 
      });
      
      // Return partial profile with just customer data
      logger.info('Returning partial customer profile due to service error', { 
        customerId: id,
        requestId: req.requestId 
      });
      
      res.status(206).json({
        ...profile,
        _warning: 'Partial profile: Account information unavailable'
      });
    }
  } catch (error) {
    logger.error('Failed to get customer profile', { 
      error: error.message, 
      stack: error.stack, 
      customerId: id, 
      requestId: req.requestId 
    });
    metrics.errorCounter.add(1, { 
      service: 'customer-service', 
      operation: 'getCustomerProfile' 
    });
    res.status(500).json({ error: 'Failed to get customer profile' });
  }
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Customer Service running on port ${PORT}`, { environment: 'cloud' });
}); 