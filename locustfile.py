import time
import random
import json
import math
import psutil
from datetime import datetime, timedelta
from locust import HttpUser, task, between, events, SequentialTaskSet

# Test data
TEST_CUSTOMERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
TEST_ACCOUNTS = ['10001', '10002', '10003', '10004', '10005', '10006', '10007', '10008', '10009', '10010']

# Base URL for the banking services
BASE_URL = "http://localhost:3000"

class SystemMetrics:
    def __init__(self):
        self.latency_history = []
        self.cpu_history = []
        self.memory_history = []
        self.max_history_size = 100

    def update_metrics(self, latency):
        # Update latency history
        self.latency_history.append(latency)
        if len(self.latency_history) > self.max_history_size:
            self.latency_history.pop(0)

        # Get current system metrics
        cpu_percent = psutil.cpu_percent()
        memory_percent = psutil.virtual_memory().percent
        
        self.cpu_history.append(cpu_percent)
        self.memory_history.append(memory_percent)
        if len(self.cpu_history) > self.max_history_size:
            self.cpu_history.pop(0)
            self.memory_history.pop(0)

    def get_average_latency(self):
        if not self.latency_history:
            return 100  # Default latency if no history
        return sum(self.latency_history) / len(self.latency_history)

    def get_system_load(self):
        if not self.cpu_history or not self.memory_history:
            return 0.5  # Default load if no history
        cpu_load = sum(self.cpu_history) / len(self.cpu_history) / 100
        memory_load = sum(self.memory_history) / len(self.memory_history) / 100
        return (cpu_load + memory_load) / 2

class TrafficPattern:
    def __init__(self, name, error_rate, latency_multiplier, request_rate):
        self.name = name
        self.error_rate = error_rate
        self.latency_multiplier = latency_multiplier
        self.request_rate = request_rate

class TrafficPatternGenerator:
    def __init__(self):
        # Define traffic patterns for different scenarios
        self.patterns = {
            "normal": TrafficPattern("normal", 0.05, 1.0, 1.0),
            "festival": TrafficPattern("festival", 0.15, 2.5, 3.0),  # High traffic during festivals
            "sales": TrafficPattern("sales", 0.20, 2.0, 2.5),       # High traffic during sales
            "month_end": TrafficPattern("month_end", 0.10, 1.5, 1.8), # Month-end processing
            "degraded": TrafficPattern("degraded", 0.25, 3.0, 0.5),
            "recovery": TrafficPattern("recovery", 0.10, 1.5, 0.8),
            "spike": TrafficPattern("spike", 0.30, 4.0, 5.0)        # Sudden user spike
        }
        self.current_pattern = "normal"
        self.pattern_start_time = time.time()
        self.test_start_time = time.time()
        self.total_duration = 720  # 12 minutes in seconds
        self.system_metrics = SystemMetrics()
        
        # Define festival, sales, and spike periods (in seconds from start)
        self.special_periods = {
            "festival": [(60, 120), (300, 360), (540, 600)],  # 3 festival periods
            "sales": [(180, 240), (420, 480)],                # 2 sales periods
            "spike": [(90, 100), (270, 280), (450, 460)]      # 3 sudden user spikes
        }

    def get_current_pattern(self):
        elapsed = time.time() - self.test_start_time
        if elapsed >= self.total_duration:
            return self.patterns["normal"]  # Default to normal if test is complete
            
        # Check for spike periods first (highest priority)
        for start, end in self.special_periods["spike"]:
            if start <= elapsed < end:
                self.current_pattern = "spike"
                return self.patterns["spike"]
            
        # Check for festival periods
        for start, end in self.special_periods["festival"]:
            if start <= elapsed < end:
                self.current_pattern = "festival"
                return self.patterns["festival"]
                
        # Check for sales periods
        for start, end in self.special_periods["sales"]:
            if start <= elapsed < end:
                self.current_pattern = "sales"
                return self.patterns["sales"]
                
        # Check for month-end periods (every 60 seconds)
        if (elapsed % 60) >= 45:  # Last 15 seconds of each "month"
            self.current_pattern = "month_end"
            return self.patterns["month_end"]
            
        # Check system load for degraded performance
        system_load = self.system_metrics.get_system_load()
        if system_load > 0.8:
            self.current_pattern = "degraded"
        elif system_load > 0.6:
            self.current_pattern = "recovery"
        else:
            self.current_pattern = "normal"
            
        return self.patterns[self.current_pattern]

class BankingUser(HttpUser):
    host = BASE_URL
    wait_time = between(0.1, 0.3)
    
    def on_start(self):
        self.session_id = f"session-{random.randint(10000, 99999)}"
        self.customer_id = random.choice(TEST_CUSTOMERS)
        self.account_number = random.choice(TEST_ACCOUNTS)
        self.balance = random.randint(1000, 10000)
        
        self.client.headers = {
            'Content-Type': 'application/json',
            'X-Session-ID': self.session_id,
            'X-Request-ID': f"req-{random.randint(100000, 999999)}",
            'X-User-Type': random.choice(['standard', 'premium', 'business'])
        }

    def measure_latency(self, response):
        if response.status_code == 200:
            latency = response.elapsed.total_seconds() * 1000  # Convert to milliseconds
            traffic_generator.system_metrics.update_metrics(latency)
            return latency
        return None

    def simulate_network_latency(self, response):
        pattern = traffic_generator.get_current_pattern()
        base_latency = traffic_generator.system_metrics.get_average_latency()
        system_load = traffic_generator.system_metrics.get_system_load()
        
        # Calculate latency based on pattern, system load, and actual measurements
        latency = base_latency * pattern.latency_multiplier * (1 + system_load)
        
        # Add some random variation
        latency *= random.uniform(0.9, 1.1)
        
        # Ensure minimum latency
        latency = max(latency, 50)
        
        time.sleep(latency / 1000)

    def inject_error(self):
        pattern = traffic_generator.get_current_pattern()
        system_load = traffic_generator.system_metrics.get_system_load()
        
        # Increase error rate based on system load
        adjusted_error_rate = pattern.error_rate * (1 + system_load)
        
        if random.random() < adjusted_error_rate:
            if system_load > 0.8:
                return random.choice([500, 503, 504])  # Server overload errors
            elif system_load > 0.6:
                return random.choice([429, 502, 503])  # Rate limiting and gateway errors
            else:
                return random.choice([400, 401, 403, 408])  # Regular errors
        return None

    @task(40)
    def view_customer_profile(self):
        pattern = traffic_generator.get_current_pattern()
        if random.random() > pattern.request_rate * 0.8:
            return

        error_code = self.inject_error()
        if error_code:
            with self.client.get(
                f"/api/customers/{self.customer_id}/profile", 
                name="View Customer Profile (Error)",
                catch_response=True
            ) as response:
                response.failure(f"Simulated error: {error_code}")
                return
        
        with self.client.get(
            f"/api/customers/{self.customer_id}/profile", 
            name="View Customer Profile",
            catch_response=True
        ) as response:
            self.measure_latency(response)
            if response.status_code == 200:
                self.simulate_network_latency(response)

    @task(25)
    def make_deposit(self):
        pattern = traffic_generator.get_current_pattern()
        if random.random() > pattern.request_rate * 0.6:
            return

        error_code = self.inject_error()
        amount = random.randint(50, 1000)
        payload = {"amount": amount}
        
        if error_code:
            with self.client.post(
                f"/api/accounts/{self.account_number}/deposit",
                json=payload,
                name="Make Deposit (Error)",
                catch_response=True
            ) as response:
                response.failure(f"Simulated error: {error_code}")
                return
        
        with self.client.post(
            f"/api/accounts/{self.account_number}/deposit",
            json=payload,
            name="Make Deposit",
            catch_response=True
        ) as response:
            self.measure_latency(response)
            if response.status_code == 200:
                self.balance += amount
                self.simulate_network_latency(response)

    @task(15)
    def make_withdrawal(self):
        pattern = traffic_generator.get_current_pattern()
        if random.random() > pattern.request_rate * 0.4:
            return

        error_code = self.inject_error()
        amount = random.randint(20, 500)
        payload = {"amount": amount}
        
        if error_code:
            with self.client.post(
                f"/api/accounts/{self.account_number}/withdrawal",
                json=payload,
                name="Make Withdrawal (Error)",
                catch_response=True
            ) as response:
                response.failure(f"Simulated error: {error_code}")
                return
        
        with self.client.post(
            f"/api/accounts/{self.account_number}/withdrawal",
            json=payload,
            name="Make Withdrawal",
            catch_response=True
        ) as response:
            self.measure_latency(response)
            if response.status_code == 200:
                self.balance -= amount
                self.simulate_network_latency(response)

    @task(10)
    def transfer_money(self):
        pattern = traffic_generator.get_current_pattern()
        if random.random() > pattern.request_rate * 0.3:
            return

        error_code = self.inject_error()
        source_account = self.account_number
        available_accounts = [acc for acc in TEST_ACCOUNTS if acc != source_account]
        
        if not available_accounts:
            return
            
        destination_account = random.choice(available_accounts)
        amount = random.randint(50, 300)
        
        payload = {
            "destinationAccount": destination_account,
            "amount": amount
        }
        
        if error_code:
            with self.client.post(
                f"/api/accounts/{source_account}/transfer",
                json=payload,
                name="Transfer Money (Error)",
                catch_response=True
            ) as response:
                response.failure(f"Simulated error: {error_code}")
                return
        
        with self.client.post(
            f"/api/accounts/{source_account}/transfer",
            json=payload,
            name="Transfer Money",
            catch_response=True
        ) as response:
            self.measure_latency(response)
            if response.status_code == 200:
                self.balance -= amount
                self.simulate_network_latency(response)

    @task(20)
    def view_transaction_history(self):
        pattern = traffic_generator.get_current_pattern()
        if random.random() > pattern.request_rate * 0.5:
            return

        error_code = self.inject_error()
        
        if error_code:
            with self.client.get(
                f"/api/accounts/{self.account_number}/transactions",
                name="View Transaction History (Error)",
                catch_response=True
            ) as response:
                response.failure(f"Simulated error: {error_code}")
                return
        
        with self.client.get(
            f"/api/accounts/{self.account_number}/transactions",
            name="View Transaction History",
            catch_response=True
        ) as response:
            self.measure_latency(response)
            if response.status_code == 200:
                self.simulate_network_latency(response)

    @task(5)
    def health_check(self):
        with self.client.get(
            "/health",
            name="Health Check",
            catch_response=True
        ) as response:
            self.measure_latency(response)
            if response.status_code != 200:
                response.failure(f"Health check failed: {response.status_code}")

# Initialize the traffic generator
traffic_generator = TrafficPatternGenerator()

# Register events for pattern changes
@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("\n12-Month Banking Traffic Simulation Started (Compressed to 12 minutes)")
    print("Simulating real-world patterns including:")
    print("- 3 Festival periods (high traffic)")
    print("- 2 Sales periods (high traffic)")
    print("- 3 Sudden user spikes (very high traffic)")
    print("- Monthly end-of-month processing")
    print("- System load-based degradation")
    print("\nTraffic Patterns:")
    for name, pattern in traffic_generator.patterns.items():
        print(f"- {name.capitalize()}:")
        print(f"  Base Error Rate: {pattern.error_rate*100}%")
        print(f"  Latency Multiplier: {pattern.latency_multiplier}x")
        print(f"  Request Rate: {pattern.request_rate}x")
    print("\nSimulation will run for 12 minutes, representing 12 months of traffic")

@events.spawning_complete.add_listener
def on_spawning_complete(user_count, **kwargs):
    print(f"\nAll {user_count} users spawned - Starting 12-month traffic simulation")
    print("Each minute represents one month of banking activity") 