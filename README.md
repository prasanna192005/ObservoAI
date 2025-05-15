# API Monitoring System with OpenTelemetry

This project demonstrates how to use OpenTelemetry to collect metrics, logs, and traces from a Node.js API and send them to multiple backends including Elasticsearch, Prometheus, and Elastic APM.

## Components

- **Node.js Express API**: A simple API that generates logs, metrics, and traces
- **OpenTelemetry SDK**: Collects telemetry data from the application
- **OpenTelemetry Collector**: Receives telemetry data and exports it to different backends
- **Elasticsearch**: Stores logs and traces data
- **Kibana**: Visualizes the logs and traces data from Elasticsearch
- **Elastic APM**: Provides APM functionality for the application
- **Prometheus**: Stores metrics data
- **Grafana**: Visualizes metrics data from Prometheus

## Prerequisites

- Node.js (v14 or later)
- Docker and Docker Compose

## Setup

1. Install the dependencies:

```bash
npm install
```

2. Start all the services using Docker Compose:

```bash
docker-compose up -d
```

3. Start the Node.js application (already started by Docker Compose):

```bash
node index.js
```

4. Run the load tester to generate traffic:

```bash
docker-compose run load-tester
```

## Testing the API

Once the application is running, you can test it by making requests to the following endpoints:

- Roll a dice: http://localhost:8080/rolldice
- Health check: http://localhost:8080/health

## Viewing the Telemetry Data

### Logs and Traces in Kibana

You can view logs and traces data in Kibana at http://localhost:5601.

1. Open Kibana and navigate to "Stack Management" > "Index Management"
2. You should see the index `api-monitoring` which contains logs and traces data
3. Create an index pattern for this index to visualize the data in Kibana's Discover view

### APM Data in Kibana

You can view APM data in Kibana at http://localhost:5601/app/apm.

### Metrics in Prometheus and Grafana

You can view metrics in:

1. Prometheus UI: http://localhost:9090
   - Try queries like `http_requests_total` or `http_request_duration_seconds`

2. Grafana: http://localhost:3000 (login with admin/admin)
   - To set up Grafana:
     1. Add Prometheus as a data source (URL: http://prometheus:9090)
     2. Import dashboards or create your own visualizations

## Configuration Files

- `instrumentation.js`: Configures the OpenTelemetry SDK in the application
- `otel-collector-config.yaml`: Configures the OpenTelemetry Collector
- `prometheus.yml`: Configures Prometheus
- `docker-compose.yaml`: Sets up the required infrastructure

## Troubleshooting

If you encounter issues with any component, check the respective logs:

```bash
# OpenTelemetry Collector logs
docker logs otel-collector

# Elasticsearch logs
docker logs elasticsearch

# Prometheus logs
docker logs prometheus

# Grafana logs
docker logs grafana
``` 