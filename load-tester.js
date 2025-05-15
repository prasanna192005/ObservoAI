/*load-tester.js*/
const axios = require('axios');

// Configuration - We'll primarily hit the Customer API which is the frontend
const CUSTOMER_API_URL = process.env.CUSTOMER_API_URL || 'http://customer-api:3000';
const REQUEST_INTERVAL_MS = 500; // Send a request every 500ms
const TOTAL_DURATION_MS = 180000; // Run for 3 minutes

// Sample customer IDs and account numbers
const testCustomers = ['1', '2', '3'];
const testAccounts = ['10001', '10002', '10003'];

// Define user journey scenarios that will create distributed traces
const userJourneys = [
  // Journey 1: View customer profile with accounts (traverses customer-api → customer-service → account-service)
  {
    name: 'View Customer Profile',
    endpoint: () => `${CUSTOMER_API_URL}/api/customers/${testCustomers[Math.floor(Math.random() * testCustomers.length)]}/profile`,
    method: 'get'
  },
  
  // Journey 2: Deposit money (traverses customer-api → transaction-service → account-service)
  {
    name: 'Make Deposit',
    endpoint: () => `${CUSTOMER_API_URL}/api/accounts/${testAccounts[Math.floor(Math.random() * testAccounts.length)]}/deposit`,
    method: 'post',
    data: () => ({
      amount: Math.floor(Math.random() * 1000) + 50
    })
  },
  
  // Journey 3: Make Withdrawal (traverses customer-api → transaction-service → account-service)
  {
    name: 'Make Withdrawal',
    endpoint: () => `${CUSTOMER_API_URL}/api/accounts/${testAccounts[Math.floor(Math.random() * testAccounts.length)]}/withdrawal`,
    method: 'post',
    data: () => ({
      amount: Math.floor(Math.random() * 500) + 20
    })
  },
  
  // Journey 4: Transfer money (traverses customer-api → transaction-service → account-service)
  {
    name: 'Transfer Money',
    endpoint: () => `${CUSTOMER_API_URL}/api/accounts/${testAccounts[Math.floor(Math.random() * testAccounts.length)]}/transfer`,
    method: 'post',
    data: () => {
      // Get two different account numbers for source and destination
      const sourceIdx = Math.floor(Math.random() * testAccounts.length);
      let destIdx = (sourceIdx + 1) % testAccounts.length; // Ensure different account
      
      return {
        destinationAccount: testAccounts[destIdx],
        amount: Math.floor(Math.random() * 300) + 50
      };
    }
  },
  
  // Journey 5: View transaction history (traverses customer-api → transaction-service)
  {
    name: 'View Transaction History',
    endpoint: () => `${CUSTOMER_API_URL}/api/accounts/${testAccounts[Math.floor(Math.random() * testAccounts.length)]}/transactions`,
    method: 'get'
  },
  
  // Health check (doesn't create distributed traces, but good for monitoring)
  {
    name: 'Health Check',
    endpoint: () => `${CUSTOMER_API_URL}/health`,
    method: 'get',
    weight: 0.5 // Lower weight means this journey happens less frequently
  }
];

// Weight the journeys (giving some more frequency than others)
const journeyWeights = [];
for (let i = 0; i < userJourneys.length; i++) {
  const weight = userJourneys[i].weight || 1;
  for (let j = 0; j < weight * 10; j++) {
    journeyWeights.push(i);
  }
}

// Track statistics
let stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  journeyStats: userJourneys.reduce((acc, journey) => {
    acc[journey.name] = { success: 0, failed: 0 };
    return acc;
  }, {}),
  startTime: Date.now()
};

// Function to make a request following a journey
async function makeRequest() {
  // Select a random journey based on weights
  const journeyIndex = journeyWeights[Math.floor(Math.random() * journeyWeights.length)];
  const journey = userJourneys[journeyIndex];
  
  // Generate request ID and session ID for tracing
  const requestId = `load-test-${Math.random().toString(36).substring(2, 12)}`;
  const sessionId = `session-${Math.random().toString(36).substring(2, 9)}`;
  
  const url = journey.endpoint();
  const method = journey.method;
  const data = journey.data ? journey.data() : undefined;
  
  console.log(`Starting journey: ${journey.name} - ${method.toUpperCase()} ${url}`);
  
  try {
    stats.totalRequests++;
    
    const response = await axios({
      method,
      url,
      data,
      timeout: 10000, // Increased timeout for distributed operations
      headers: {
        'X-Request-ID': requestId,
        'X-Session-ID': sessionId,
        'Content-Type': 'application/json'
      }
    });
    
    stats.successfulRequests++;
    stats.journeyStats[journey.name].success++;
    
    console.log(`Success: ${journey.name} - ${method.toUpperCase()} ${url} - Status: ${response.status}`);
  } catch (error) {
    stats.failedRequests++;
    stats.journeyStats[journey.name].failed++;
    
    if (error.response) {
      console.log(`Error: ${journey.name} - ${method.toUpperCase()} ${url} - Status: ${error.response.status}`);
    } else {
      console.log(`Error: ${journey.name} - ${method.toUpperCase()} ${url} - ${error.message}`);
    }
  }
}

// Function to print statistics
function printStats() {
  const runningTime = (Date.now() - stats.startTime) / 1000;
  console.log('\n--- Banking Load Test Statistics ---');
  console.log(`Running time: ${runningTime.toFixed(2)} seconds`);
  console.log(`Total requests: ${stats.totalRequests}`);
  console.log(`Successful requests: ${stats.successfulRequests}`);
  console.log(`Failed requests: ${stats.failedRequests}`);
  console.log(`Requests per second: ${(stats.totalRequests / runningTime).toFixed(2)}`);
  
  console.log('\nJourney Statistics:');
  for (const [journey, data] of Object.entries(stats.journeyStats)) {
    console.log(`${journey}: ${data.success} successful, ${data.failed} failed`);
  }
  
  console.log('----------------------------------\n');
}

// Start the load test
console.log('Starting banking services load test with end-to-end user journeys...');
console.log('This will create distributed traces across multiple services');

// Set up the periodic request interval
const intervalId = setInterval(makeRequest, REQUEST_INTERVAL_MS);

// Set up periodic stats printing
const statsIntervalId = setInterval(printStats, 10000);

// Set a timeout to stop the test after the specified duration
setTimeout(() => {
  clearInterval(intervalId);
  clearInterval(statsIntervalId);
  printStats();
  console.log('Banking load test complete.');
}, TOTAL_DURATION_MS);

// Make the first request immediately
makeRequest(); 