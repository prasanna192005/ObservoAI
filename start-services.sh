#!/bin/bash

# Start services with anomaly detection configuration
echo "Starting Banking API services with anomaly detection enabled..."

# Check if docker-compose exists
if ! command -v docker-compose &> /dev/null; then
    echo "docker-compose not found. Please install it first."
    exit 1
fi

# Start infrastructure services first
echo "Starting infrastructure services (Elasticsearch, Prometheus, Grafana, OpenTelemetry Collector)..."
docker-compose up -d elasticsearch prometheus grafana otel-collector

# Wait for infrastructure to be ready
echo "Waiting for infrastructure services to be ready..."
sleep 10

# Start banking services
echo "Starting banking services..."
docker-compose up -d account-service customer-service transaction-service customer-api-service

# Wait for services to be ready
echo "Waiting for banking services to be ready..."
sleep 5

# Start test data generator
echo "Starting test data generator for anomaly scenarios..."
node banking-services/generate-test-data.js &
TEST_DATA_PID=$!

# Print access information
echo ""
echo "Services started successfully!"
echo ""
echo "Access points:"
echo "- Grafana: http://localhost:3000"
echo "  - Username: admin"
echo "  - Password: admin"
echo "  - Anomaly Detection Dashboard: http://localhost:3000/d/anomaly-detection"
echo ""
echo "- Prometheus: http://localhost:9090"
echo "- Elasticsearch: http://localhost:9200"
echo "- Customer API: http://localhost:3000"
echo "- Customer Service: http://localhost:3003"
echo "- Account Service: http://localhost:3002"
echo "- Transaction Service: http://localhost:3004"
echo ""
echo "Test data generator is running in the background (PID: $TEST_DATA_PID)"
echo "Press Ctrl+C to stop all services"

# Handle cleanup on script exit
function cleanup {
    echo "Stopping test data generator..."
    kill $TEST_DATA_PID
    
    echo "Stopping all services..."
    docker-compose down
    
    echo "All services stopped."
}

trap cleanup EXIT

# Keep the script running to maintain log output
docker-compose logs -f 