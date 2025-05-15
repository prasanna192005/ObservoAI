from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
import logging
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import joblib
import os
import requests

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Grafana ML Service")

# Models storage
MODELS_DIR = "ml_models"
os.makedirs(MODELS_DIR, exist_ok=True)

# Prometheus configuration
PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://localhost:9090")

class TimeSeriesData(BaseModel):
    timestamps: List[datetime]
    values: List[float]
    metric_name: str

class GrafanaQueryTarget(BaseModel):
    target: str
    refId: Optional[str] = None
    type: Optional[str] = "timeserie"

class GrafanaTimeRange(BaseModel):
    from_: str = Field(..., alias="from")
    to: str

class GrafanaQueryRequest(BaseModel):
    panelId: Optional[int] = None
    range: GrafanaTimeRange
    intervalMs: Optional[int] = None
    targets: List[GrafanaQueryTarget]
    maxDataPoints: Optional[int] = None
    format: Optional[str] = "json"

class GrafanaAnnotationRequest(BaseModel):
    range: GrafanaTimeRange
    annotation: Dict[str, Any]

@app.get("/")
async def root():
    """Root endpoint for health checks"""
    return {"status": "ok"}

@app.post("/search")
async def search():
    """Return available metrics for querying"""
    return [
        "error_rate_prediction",
        "latency_prediction",
        "active_users_prediction",
        "transaction_rate_prediction",
        "error_rate_anomalies",
        "latency_anomalies",
        "active_users_anomalies",
        "transaction_rate_anomalies"
    ]

@app.post("/query")
async def query(request: GrafanaQueryRequest):
    """Handle Grafana queries for predictions and anomalies"""
    try:
        results = []
        
        for target in request.targets:
            if target.target.endswith("_prediction"):
                # Handle prediction requests
                metric_name = target.target.replace("_prediction", "")
                prometheus_query = get_prometheus_query(metric_name)
                
                # Fetch historical data from Prometheus
                historical_data = fetch_prometheus_data(
                    prometheus_query,
                    request.range.from_,
                    request.range.to
                )
                
                # Generate predictions
                predictions = generate_predictions(historical_data)
                results.append({
                    "target": f"{metric_name}_prediction",
                    "datapoints": predictions
                })
                
            elif target.target.endswith("_anomalies"):
                # Handle anomaly detection requests
                metric_name = target.target.replace("_anomalies", "")
                prometheus_query = get_prometheus_query(metric_name)
                
                # Fetch data from Prometheus
                data = fetch_prometheus_data(
                    prometheus_query,
                    request.range.from_,
                    request.range.to
                )
                
                # Detect anomalies
                anomalies = detect_anomalies(data, metric_name)
                results.append({
                    "target": f"{metric_name}_anomalies",
                    "datapoints": anomalies
                })
        
        return results
    
    except Exception as e:
        logger.error(f"Error processing query: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/annotations")
async def annotations(request: GrafanaAnnotationRequest):
    """Handle Grafana annotation requests"""
    try:
        # Extract metric name from annotation
        metric_name = request.annotation.get("name", "").replace("_anomalies", "")
        
        # Fetch data and detect anomalies
        prometheus_query = get_prometheus_query(metric_name)
        data = fetch_prometheus_data(
            prometheus_query,
            request.range.from_,
            request.range.to
        )
        
        anomalies = detect_anomalies(data, metric_name)
        
        # Format annotations
        return [
            {
                "time": timestamp,
                "title": f"Anomaly detected in {metric_name}",
                "text": f"Value: {value}",
                "tags": ["anomaly"]
            }
            for timestamp, value in anomalies
            if value < 0  # Only include actual anomalies
        ]
    
    except Exception as e:
        logger.error(f"Error processing annotations: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def get_prometheus_query(metric_name: str) -> str:
    """Get Prometheus query for a specific metric"""
    queries = {
        "error_rate": 'rate(bank_bank_early_warning_signals_total{service_name="customer-api-service", route="POST:/api/accounts/10002/deposit", signal="ERROR_RATE_APPROACHING_THRESHOLD"}[5m])',
        "latency": 'bank_bank_baseline_latency_seconds{service_name="customer-api-service", route="POST:/api/accounts/10002/withdrawal", p99="0.0509"}',
        "active_users": 'bank_bank_active_users{service_name="customer-api-service"}',
        "transaction_rate": 'rate(bank_bank_transactions_total{service_name="transaction-service", route="POST:/api/transactions"}[5m])'
    }
    return queries.get(metric_name, "")

def fetch_prometheus_data(query: str, start_time: str, end_time: str) -> List[tuple]:
    """Fetch data from Prometheus"""
    try:
        response = requests.get(
            f"{PROMETHEUS_URL}/api/v1/query_range",
            params={
                "query": query,
                "start": start_time,
                "end": end_time,
                "step": "1m"
            }
        )
        response.raise_for_status()
        data = response.json()
        
        if data["status"] == "success":
            result = data["data"]["result"][0]
            return [(float(ts), float(val)) for ts, val in result["values"]]
        return []
    
    except Exception as e:
        logger.error(f"Error fetching Prometheus data: {str(e)}")
        return []

def generate_predictions(data: List[tuple]) -> List[tuple]:
    """Generate predictions for time series data"""
    if not data:
        return []
    
    # Convert to numpy arrays
    timestamps = np.array([ts for ts, _ in data])
    values = np.array([val for _, val in data])
    
    # Calculate basic statistics
    mean = np.mean(values)
    std = np.std(values)
    
    # Generate predictions
    last_timestamp = max(timestamps)
    predictions = []
    
    for i in range(24):  # Predict next 24 hours
        future_timestamp = last_timestamp + (i + 1) * 3600  # Add hours in seconds
        prediction = mean + np.random.normal(0, std/2)
        predictions.append((future_timestamp, prediction))
    
    return predictions

def detect_anomalies(data: List[tuple], metric_name: str) -> List[tuple]:
    """Detect anomalies in time series data"""
    if not data:
        return []
    
    # Load or train model
    model_path = os.path.join(MODELS_DIR, f"{metric_name}_anomaly_model.joblib")
    scaler_path = os.path.join(MODELS_DIR, f"{metric_name}_scaler.joblib")
    
    if not os.path.exists(model_path):
        # Train new model if none exists
        X = np.array([val for _, val in data]).reshape(-1, 1)
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)
        
        model = IsolationForest(contamination=0.1, random_state=42)
        model.fit(X_scaled)
        
        joblib.dump(model, model_path)
        joblib.dump(scaler, scaler_path)
    else:
        # Load existing model
        model = joblib.load(model_path)
        scaler = joblib.load(scaler_path)
    
    # Prepare data
    X = np.array([val for _, val in data]).reshape(-1, 1)
    X_scaled = scaler.transform(X)
    
    # Predict anomalies
    predictions = model.predict(X_scaled)
    anomaly_scores = model.score_samples(X_scaled)
    
    # Return timestamps with anomaly scores
    return [(ts, score) for (ts, _), score in zip(data, anomaly_scores)]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001) 