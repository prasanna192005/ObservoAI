/*database.js*/
// Simple in-memory database for demonstration
const { v4: uuidv4 } = require('uuid');

// In-memory database tables
const db = {
  customers: [
    { id: '1', name: 'John Doe', email: 'john@example.com', accountNumber: '10001', balance: 5000 },
    { id: '2', name: 'Jane Smith', email: 'jane@example.com', accountNumber: '10002', balance: 7500 },
    { id: '3', name: 'Robert Johnson', email: 'robert@example.com', accountNumber: '10003', balance: 12000 }
  ],
  
  accounts: [
    {
      accountNumber: '10001',
      customerId: '1',
      type: 'checking',
      balance: 5000,
      status: 'active',
      createdAt: new Date(Date.now() - 86400000 * 30).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString()
    },
    {
      accountNumber: '10002',
      customerId: '2',
      type: 'savings',
      balance: 7500,
      status: 'active',
      createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
      updatedAt: new Date(Date.now() - 86400000 * 2).toISOString()
    },
    {
      accountNumber: '10003',
      customerId: '3',
      type: 'investment',
      balance: 12000,
      status: 'active',
      createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
      updatedAt: new Date(Date.now() - 86400000 * 5).toISOString()
    }
  ],
  
  transactions: [
    { 
      id: 't1', 
      accountNumber: '10001', 
      type: 'deposit', 
      amount: 1000, 
      timestamp: new Date(Date.now() - 86400000).toISOString(),
      status: 'completed'
    },
    { 
      id: 't2', 
      accountNumber: '10002', 
      type: 'withdrawal', 
      amount: 500, 
      timestamp: new Date(Date.now() - 43200000).toISOString(),
      status: 'completed'
    },
    { 
      id: 't3', 
      accountNumber: '10001', 
      type: 'transfer', 
      amount: 750, 
      destinationAccount: '10003',
      timestamp: new Date(Date.now() - 21600000).toISOString(),
      status: 'completed'
    }
  ],
  
  sessions: [],
  
  analytics: {
    activeSessions: 0,
    totalTransactions: 3,
    depositTotal: 1000,
    withdrawalTotal: 500,
    transferTotal: 750
  }
};

// Account operations
const accountOperations = {
  getAccounts: () => {
    return db.accounts;
  },
  
  getAccountByNumber: (accountNumber) => {
    return db.accounts.find(a => a.accountNumber === accountNumber);
  },
  
  getAccountsByCustomerId: (customerId) => {
    return db.accounts.filter(a => a.customerId === customerId);
  },
  
  createAccount: (account) => {
    db.accounts.push(account);
    return account;
  },
  
  updateAccountStatus: (accountNumber, status) => {
    const account = accountOperations.getAccountByNumber(accountNumber);
    if (account) {
      account.status = status;
      account.updatedAt = new Date().toISOString();
      return account;
    }
    return null;
  },
  
  updateAccountBalance: (accountNumber, amount, operation = 'add') => {
    const account = accountOperations.getAccountByNumber(accountNumber);
    if (account) {
      if (operation === 'add') {
        account.balance += amount;
      } else if (operation === 'subtract') {
        account.balance -= amount;
      } else {
        return null;
      }
      account.updatedAt = new Date().toISOString();
      return account;
    }
    return null;
  },
  
  getAccountStatistics: () => {
    return {
      total: db.accounts.length,
      byType: {
        checking: db.accounts.filter(a => a.type === 'checking').length,
        savings: db.accounts.filter(a => a.type === 'savings').length,
        investment: db.accounts.filter(a => a.type === 'investment').length
      },
      byStatus: {
        active: db.accounts.filter(a => a.status === 'active').length,
        suspended: db.accounts.filter(a => a.status === 'suspended').length,
        closed: db.accounts.filter(a => a.status === 'closed').length
      },
      totalBalance: db.accounts.reduce((sum, account) => sum + account.balance, 0)
    };
  },
  
  searchAccounts: (criteria) => {
    let results = [...db.accounts];
    
    if (criteria.query) {
      const query = criteria.query.toLowerCase();
      results = results.filter(a => 
        a.accountNumber.toLowerCase().includes(query) || 
        a.customerId.toLowerCase().includes(query)
      );
    }
    
    if (criteria.type) {
      results = results.filter(a => a.type === criteria.type);
    }
    
    if (criteria.status) {
      results = results.filter(a => a.status === criteria.status);
    }
    
    if (criteria.minBalance !== undefined) {
      results = results.filter(a => a.balance >= criteria.minBalance);
    }
    
    if (criteria.maxBalance !== undefined) {
      results = results.filter(a => a.balance <= criteria.maxBalance);
    }
    
    return results;
  }
};

// Customer operations
const customerOperations = {
  getCustomers: () => {
    return db.customers;
  },
  
  getCustomerById: (id) => {
    return db.customers.find(c => c.id === id);
  },
  
  getCustomerByAccountNumber: (accountNumber) => {
    return db.customers.find(c => c.accountNumber === accountNumber);
  },
  
  getCustomerBalance: (accountNumber) => {
    const customer = db.customers.find(c => c.accountNumber === accountNumber);
    return customer ? customer.balance : null;
  },
  
  updateCustomerBalance: (accountNumber, amount) => {
    const customer = db.customers.find(c => c.accountNumber === accountNumber);
    if (customer) {
      customer.balance += amount;
      return true;
    }
    return false;
  }
};

// Transaction operations
const transactionOperations = {
  getTransactions: () => {
    return db.transactions;
  },
  
  getTransactionById: (id) => {
    return db.transactions.find(t => t.id === id);
  },
  
  getTransactionsByAccountNumber: (accountNumber) => {
    return db.transactions.filter(t => t.accountNumber === accountNumber);
  },
  
  getAccountTransactions: (filters, pagination = { limit: 10, offset: 0 }) => {
    let transactions = db.transactions;
    
    // Apply filters
    if (filters.accountNumber) {
      transactions = transactions.filter(t => 
        t.accountNumber === filters.accountNumber || 
        t.targetAccountNumber === filters.accountNumber
      );
    }
    
    if (filters.accountNumbers && Array.isArray(filters.accountNumbers)) {
      transactions = transactions.filter(t => 
        filters.accountNumbers.includes(t.accountNumber) || 
        filters.accountNumbers.includes(t.targetAccountNumber)
      );
    }
    
    if (filters.startDate) {
      transactions = transactions.filter(t => new Date(t.timestamp) >= filters.startDate);
    }
    
    if (filters.endDate) {
      transactions = transactions.filter(t => new Date(t.timestamp) <= filters.endDate);
    }
    
    if (filters.type) {
      transactions = transactions.filter(t => t.type === filters.type);
    }
    
    const total = transactions.length;
    
    // Apply pagination
    if (pagination) {
      const { offset = 0, limit = 10 } = pagination;
      transactions = transactions.slice(offset, offset + limit);
    }
    
    return { transactions, total };
  },
  
  getCustomerTransactions: (filters, pagination = { limit: 10, offset: 0 }) => {
    return transactionOperations.getAccountTransactions(filters, pagination);
  },
  
  verifyTransaction: (id) => {
    const transaction = transactionOperations.getTransactionById(id);
    
    if (!transaction) {
      return { transaction: null, verified: false };
    }
    
    // Perform verification logic based on transaction type
    let verified = transaction.status === 'completed';
    
    // Additional verification for transfers - Check both accounts
    if (transaction.type === 'transfer') {
      const sourceAccount = transaction.accountNumber;
      const destinationAccount = transaction.destinationAccount;
      
      // In a real system, we'd perform advanced verification:
      // - Check that the source account had sufficient funds
      // - Verify that the destination account received the money
      // - Confirm transaction timestamps match expected times
      
      // For this demo, we'll just check that both accounts exist
      const sourceExists = customerOperations.getCustomerByAccountNumber(sourceAccount) !== null;
      const destExists = customerOperations.getCustomerByAccountNumber(destinationAccount) !== null;
      
      verified = verified && sourceExists && destExists;
    }
    
    return {
      transaction,
      verified,
      verificationTime: new Date().toISOString()
    };
  },
  
  getTransactionStatistics: (period = 'day') => {
    const now = new Date();
    let startDate;
    
    // Calculate start date based on period
    switch (period) {
      case 'day':
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 1);
        break;
      case 'week':
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 7);
        break;
      case 'month':
        startDate = new Date(now);
        startDate.setMonth(now.getMonth() - 1);
        break;
      default:
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 1);
    }
    
    // Filter transactions by date
    const periodTransactions = db.transactions.filter(t => 
      new Date(t.timestamp) >= startDate && new Date(t.timestamp) <= now
    );
    
    // Calculate statistics
    const depositTransactions = periodTransactions.filter(t => t.type === 'deposit');
    const withdrawalTransactions = periodTransactions.filter(t => t.type === 'withdrawal');
    const transferTransactions = periodTransactions.filter(t => t.type === 'transfer');
    
    const totalTransactions = periodTransactions.length;
    const totalAmount = periodTransactions.reduce((sum, t) => sum + t.amount, 0);
    
    const depositTotal = depositTransactions.reduce((sum, t) => sum + t.amount, 0);
    const withdrawalTotal = withdrawalTransactions.reduce((sum, t) => sum + t.amount, 0);
    const transferTotal = transferTransactions.reduce((sum, t) => sum + t.amount, 0);
    
    return {
      period,
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalTransactions,
      totalAmount,
      byType: {
        deposit: {
          count: depositTransactions.length,
          total: depositTotal
        },
        withdrawal: {
          count: withdrawalTransactions.length,
          total: withdrawalTotal
        },
        transfer: {
          count: transferTransactions.length,
          total: transferTotal
        }
      },
      byStatus: {
        completed: periodTransactions.filter(t => t.status === 'completed').length,
        pending: periodTransactions.filter(t => t.status === 'pending').length,
        failed: periodTransactions.filter(t => t.status === 'failed').length
      }
    };
  },
  
  createTransaction: (transaction) => {
    const newTransaction = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      status: 'pending',
      ...transaction
    };
    
    db.transactions.push(newTransaction);
    
    // Update analytics
    db.analytics.totalTransactions++;
    if (transaction.type === 'deposit') {
      db.analytics.depositTotal += transaction.amount;
    } else if (transaction.type === 'withdrawal') {
      db.analytics.withdrawalTotal += transaction.amount;
    } else if (transaction.type === 'transfer') {
      db.analytics.transferTotal += transaction.amount;
    }
    
    return newTransaction;
  },
  
  updateTransactionStatus: (id, status) => {
    const transaction = db.transactions.find(t => t.id === id);
    if (transaction) {
      transaction.status = status;
      return transaction;
    }
    return null;
  },
  
  processDeposit: (accountNumber, amount) => {
    // Create transaction record
    const transaction = transactionOperations.createTransaction({
      accountNumber,
      type: 'deposit',
      amount
    });
    
    // Update customer balance
    const success = customerOperations.updateCustomerBalance(accountNumber, amount);
    
    // Update transaction status
    if (success) {
      transactionOperations.updateTransactionStatus(transaction.id, 'completed');
      return { success: true, transaction };
    }
    
    transactionOperations.updateTransactionStatus(transaction.id, 'failed');
    return { success: false, transaction };
  },
  
  processWithdrawal: (accountNumber, amount) => {
    // Check if customer has sufficient balance
    const balance = customerOperations.getCustomerBalance(accountNumber);
    if (balance === null || balance < amount) {
      const transaction = transactionOperations.createTransaction({
        accountNumber,
        type: 'withdrawal',
        amount,
        status: 'failed',
        reason: 'Insufficient funds'
      });
      return { success: false, transaction, reason: 'Insufficient funds' };
    }
    
    // Create transaction record
    const transaction = transactionOperations.createTransaction({
      accountNumber,
      type: 'withdrawal',
      amount
    });
    
    // Update customer balance
    const success = customerOperations.updateCustomerBalance(accountNumber, -amount);
    
    // Update transaction status
    if (success) {
      transactionOperations.updateTransactionStatus(transaction.id, 'completed');
      return { success: true, transaction };
    }
    
    transactionOperations.updateTransactionStatus(transaction.id, 'failed');
    return { success: false, transaction };
  },
  
  processTransfer: (sourceAccount, destinationAccount, amount) => {
    // Check if source customer has sufficient balance
    const sourceBalance = customerOperations.getCustomerBalance(sourceAccount);
    if (sourceBalance === null || sourceBalance < amount) {
      const transaction = transactionOperations.createTransaction({
        accountNumber: sourceAccount,
        destinationAccount,
        type: 'transfer',
        amount,
        status: 'failed',
        reason: 'Insufficient funds'
      });
      return { success: false, transaction, reason: 'Insufficient funds' };
    }
    
    // Check if destination account exists
    const destinationCustomer = customerOperations.getCustomerByAccountNumber(destinationAccount);
    if (!destinationCustomer) {
      const transaction = transactionOperations.createTransaction({
        accountNumber: sourceAccount,
        destinationAccount,
        type: 'transfer',
        amount,
        status: 'failed',
        reason: 'Destination account not found'
      });
      return { success: false, transaction, reason: 'Destination account not found' };
    }
    
    // Create transaction record
    const transaction = transactionOperations.createTransaction({
      accountNumber: sourceAccount,
      destinationAccount,
      type: 'transfer',
      amount
    });
    
    // Update balances
    const sourceUpdate = customerOperations.updateCustomerBalance(sourceAccount, -amount);
    const destUpdate = customerOperations.updateCustomerBalance(destinationAccount, amount);
    
    // Update transaction status
    if (sourceUpdate && destUpdate) {
      transactionOperations.updateTransactionStatus(transaction.id, 'completed');
      return { success: true, transaction };
    }
    
    // Rollback if something went wrong
    if (sourceUpdate) {
      customerOperations.updateCustomerBalance(sourceAccount, amount);
    }
    
    transactionOperations.updateTransactionStatus(transaction.id, 'failed');
    return { success: false, transaction };
  }
};

// Analytics operations
const analyticsOperations = {
  getAnalytics: () => {
    return db.analytics;
  },
  
  getTransactionSummary: () => {
    return {
      totalCount: db.transactions.length,
      completedCount: db.transactions.filter(t => t.status === 'completed').length,
      pendingCount: db.transactions.filter(t => t.status === 'pending').length,
      failedCount: db.transactions.filter(t => t.status === 'failed').length,
      depositTotal: db.analytics.depositTotal,
      withdrawalTotal: db.analytics.withdrawalTotal,
      transferTotal: db.analytics.transferTotal
    };
  },
  
  getTransactionsByType: () => {
    return {
      deposits: db.transactions.filter(t => t.type === 'deposit'),
      withdrawals: db.transactions.filter(t => t.type === 'withdrawal'),
      transfers: db.transactions.filter(t => t.type === 'transfer')
    };
  },
  
  trackSession: (sessionId, active = true) => {
    if (active) {
      db.sessions.push(sessionId);
      db.analytics.activeSessions = db.sessions.length;
    } else {
      const index = db.sessions.indexOf(sessionId);
      if (index !== -1) {
        db.sessions.splice(index, 1);
      }
      db.analytics.activeSessions = db.sessions.length;
    }
    return db.analytics.activeSessions;
  }
};

module.exports = {
  customerOperations,
  transactionOperations,
  analyticsOperations,
  accountOperations
}; 