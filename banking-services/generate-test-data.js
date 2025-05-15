/*generate-test-data.js*/
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Configuration for test data generation
const CONFIG = {
  // Base URLs for each service
  customerApiUrl: process.env.CUSTOMER_API_URL || 'http://localhost:3000',
  customerServiceUrl: process.env.CUSTOMER_SERVICE_URL || 'http://localhost:3003',
  accountServiceUrl: process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3002',
  transactionServiceUrl: process.env.TRANSACTION_SERVICE_URL || 'http://localhost:3004',
  
  // Test scenarios
  scenarios: {
    // Normal traffic
    normalTraffic: {
      enabled: true,
      duration: 60000, // 1 minute of normal traffic
      requestInterval: 500, // Every 500ms
      errorRate: 0.05, // 5% of requests will be intentional errors
    },
    
    // Latency spike scenario
    latencySpike: {
      enabled: true,
      startAfter: 60000, // Start after 1 minute
      duration: 30000, // 30 seconds of latency issues
      requestInterval: 200, // Faster requests during spike
      artificialLatency: {
        min: 500, // Minimum extra latency in ms
        max: 2000, // Maximum extra latency in ms
      },
      affectedServices: ['account-service'], // Which services to target
      affectedRoutes: ['/api/accounts', '/api/accounts/:id'],
    },
    
    // Error rate spike scenario
    errorRateSpike: {
      enabled: true,
      startAfter: 120000, // Start after 2 minutes
      duration: 30000, // 30 seconds of error issues
      requestInterval: 300, // Every 300ms
      errorRate: 0.4, // 40% error rate during spike
      affectedServices: ['transaction-service'],
      errorType: '500', // Generate server errors
    },
    
    // Pattern change scenario - subtle shift in latency pattern
    patternChange: {
      enabled: true,
      startAfter: 180000, // Start after 3 minutes
      duration: 60000,  // 1 minute of pattern change
      requestInterval: 400,
      latencyShift: 200, // Add 200ms to all requests to simulate a subtle shift
      affectedServices: ['customer-service'],
    },
    
    // Early warning signals scenario
    earlyWarningSignals: {
      enabled: true,
      startAfter: 300000, // Start after 5 minutes
      duration: 120000, // 2 minutes of early warnings
      requestInterval: 500,
      gradualLatencyIncrease: {
        initialAdditionalMs: 100,
        incrementPerRequestMs: 5,
        maxAdditionalMs: 1000,
      },
      affectedServices: ['transaction-service'],
    },
  },
};

// Test data generation state
const STATE = {
  sessionId: uuidv4(),
  currentScenario: null,
  startTime: Date.now(),
  runningScenarios: new Set(),
  testAccounts: [],
  testCustomers: [],
};

// Utility functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function simulateLatency(scenario) {
  const latency = randomInt(
    scenario.artificialLatency.min,
    scenario.artificialLatency.max
  );
  await sleep(latency);
}

// Request generators for different services
async function generateCustomerApiRequests(scenario) {
  const requestId = uuidv4();
  const endpoint = '/api/customers';
  
  try {
    // Determine if we should generate an error
    const shouldError = Math.random() < (scenario.errorRate || 0);
    
    if (shouldError) {
      // Invalid request to trigger error
      await axios.get(`${CONFIG.customerApiUrl}${endpoint}/invalid-id-99999`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    } else {
      // Valid request
      await axios.get(`${CONFIG.customerApiUrl}${endpoint}`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    }
  } catch (error) {
    // Expected errors are fine for test data
    console.log(`[TEST DATA] Generated ${error.response?.status || 'error'} on ${endpoint}`);
  }
}

async function generateAccountServiceRequests(scenario) {
  const requestId = uuidv4();
  const endpoints = [
    '/api/accounts',
    '/api/accounts/10001',
    '/api/accounts/10002',
    '/api/accounts/10003',
  ];
  const endpoint = endpoints[randomInt(0, endpoints.length - 1)];
  
  try {
    // Determine if we should generate an error
    const shouldError = Math.random() < (scenario.errorRate || 0);
    
    // Check if we should add artificial latency to this service
    if (scenario.artificialLatency && 
        (!scenario.affectedServices || 
         scenario.affectedServices.includes('account-service'))) {
      await simulateLatency(scenario);
    }
    
    if (shouldError) {
      // Invalid request to trigger error
      await axios.get(`${CONFIG.accountServiceUrl}/api/accounts/invalid-9999`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    } else {
      // Valid request
      await axios.get(`${CONFIG.accountServiceUrl}${endpoint}`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    }
  } catch (error) {
    // Expected errors are fine for test data
    console.log(`[TEST DATA] Generated ${error.response?.status || 'error'} on ${endpoint}`);
  }
}

async function generateTransactionServiceRequests(scenario) {
  const requestId = uuidv4();
  const endpoints = [
    '/api/transactions',
    '/api/transactions/statistics',
    '/api/customers/1/transactions',
    '/api/customers/2/transactions',
    '/api/customers/3/transactions',
  ];
  const endpoint = endpoints[randomInt(0, endpoints.length - 1)];
  
  try {
    // Determine if we should generate an error
    const shouldError = Math.random() < (scenario.errorRate || 0);
    
    // Check if we should add artificial latency to this service
    if (scenario.artificialLatency && 
        (!scenario.affectedServices || 
         scenario.affectedServices.includes('transaction-service'))) {
      await simulateLatency(scenario);
    }
    
    if (shouldError) {
      if (scenario.errorType === '500') {
        // Generate a malformed request that will cause server error
        await axios.post(`${CONFIG.transactionServiceUrl}/api/transactions`, 
          { malformed: true }, // Missing required fields
          {
            headers: {
              'X-Request-ID': requestId,
              'X-Session-ID': STATE.sessionId,
            },
          }
        );
      } else {
        // Invalid request to trigger 404
        await axios.get(`${CONFIG.transactionServiceUrl}/api/transactions/invalid-9999`, {
          headers: {
            'X-Request-ID': requestId,
            'X-Session-ID': STATE.sessionId,
          },
        });
      }
    } else if (endpoint === '/api/transactions') {
      // For transactions endpoint, we can post a new transaction
      const transactionTypes = ['deposit', 'withdrawal', 'transfer'];
      const type = transactionTypes[randomInt(0, transactionTypes.length - 1)];
      const amount = randomInt(10, 500);
      
      let payload = {};
      
      if (type === 'deposit') {
        payload = {
          type,
          targetAccountNumber: '10001',
          amount,
          description: 'Test deposit'
        };
      } else if (type === 'withdrawal') {
        payload = {
          type,
          sourceAccountNumber: '10001',
          amount,
          description: 'Test withdrawal'
        };
      } else if (type === 'transfer') {
        payload = {
          type,
          sourceAccountNumber: '10001',
          targetAccountNumber: '10002',
          amount,
          description: 'Test transfer'
        };
      }
      
      await axios.post(`${CONFIG.transactionServiceUrl}/api/transactions`, payload, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    } else {
      // Valid request
      await axios.get(`${CONFIG.transactionServiceUrl}${endpoint}`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    }
  } catch (error) {
    // Expected errors are fine for test data
    console.log(`[TEST DATA] Generated ${error.response?.status || 'error'} on ${endpoint}`);
  }
}

async function generateCustomerServiceRequests(scenario) {
  const requestId = uuidv4();
  const endpoints = [
    '/api/customers',
    '/api/customers/1',
    '/api/customers/2',
    '/api/customers/3',
    '/api/customers/1/profile',
  ];
  const endpoint = endpoints[randomInt(0, endpoints.length - 1)];
  
  try {
    // Determine if we should generate an error
    const shouldError = Math.random() < (scenario.errorRate || 0);
    
    // If this is a pattern change scenario and affects customer-service
    if (scenario.latencyShift && 
        (!scenario.affectedServices || 
         scenario.affectedServices.includes('customer-service'))) {
      await sleep(scenario.latencyShift);
    }
    
    if (shouldError) {
      // Invalid request to trigger error
      await axios.get(`${CONFIG.customerServiceUrl}/api/customers/invalid-id-99999`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    } else {
      // Valid request
      await axios.get(`${CONFIG.customerServiceUrl}${endpoint}`, {
        headers: {
          'X-Request-ID': requestId,
          'X-Session-ID': STATE.sessionId,
        },
      });
    }
  } catch (error) {
    // Expected errors are fine for test data
    console.log(`[TEST DATA] Generated ${error.response?.status || 'error'} on ${endpoint}`);
  }
}

// Main scenario runner
async function runScenario(scenarioName) {
  const scenario = CONFIG.scenarios[scenarioName];
  if (!scenario || !scenario.enabled) return;
  
  console.log(`[TEST DATA] Starting scenario: ${scenarioName}`);
  STATE.runningScenarios.add(scenarioName);
  STATE.currentScenario = scenarioName;
  
  const endTime = Date.now() + scenario.duration;
  
  // Add early warning specific setup
  let additionalLatency = 0;
  if (scenarioName === 'earlyWarningSignals' && scenario.gradualLatencyIncrease) {
    additionalLatency = scenario.gradualLatencyIncrease.initialAdditionalMs;
  }
  
  while (Date.now() < endTime) {
    // Skip if test was stopped
    if (!STATE.runningScenarios.has(scenarioName)) break;
    
    // Update early warning latency if applicable
    if (scenarioName === 'earlyWarningSignals' && scenario.gradualLatencyIncrease) {
      additionalLatency = Math.min(
        additionalLatency + scenario.gradualLatencyIncrease.incrementPerRequestMs,
        scenario.gradualLatencyIncrease.maxAdditionalMs
      );
      
      // Apply the increasing latency
      await sleep(additionalLatency);
    }
    
    // Generate a random request to a random service
    const serviceSelector = randomInt(1, 4);
    
    switch (serviceSelector) {
      case 1:
        await generateCustomerApiRequests(scenario);
        break;
      case 2:
        await generateAccountServiceRequests(scenario);
        break;
      case 3:
        await generateTransactionServiceRequests(scenario);
        break;
      case 4:
        await generateCustomerServiceRequests(scenario);
        break;
    }
    
    // Wait before next request
    await sleep(scenario.requestInterval);
  }
  
  STATE.runningScenarios.delete(scenarioName);
  console.log(`[TEST DATA] Completed scenario: ${scenarioName}`);
}

// Main function to start test data generation
async function startTestDataGeneration() {
  console.log('[TEST DATA] Starting test data generation...');
  
  // Schedule all scenarios
  Object.entries(CONFIG.scenarios).forEach(([name, scenario]) => {
    if (scenario.enabled) {
      setTimeout(() => {
        runScenario(name);
      }, scenario.startAfter || 0);
    }
  });
  
  // Start with normal traffic immediately
  runScenario('normalTraffic');
}

// Start the test data generation
startTestDataGeneration().catch(err => {
  console.error('[TEST DATA] Error in test data generation:', err);
});

// Keep the script running
process.stdin.resume();
console.log('[TEST DATA] Press Ctrl+C to stop the test data generation.'); 