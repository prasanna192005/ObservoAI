# predict.py
import json
import os
import asyncio
from datetime import datetime, timedelta, timezone
import pandas as pd
import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional, Union
import logging
import time # For timing operations

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Prophet Import Handling ---
try:
    from prophet import Prophet
    logging.info("Prophet library imported successfully.")
    # Suppress Prophet's verbose output if needed
    logging.getLogger('cmdstanpy').setLevel(logging.WARNING)
except ImportError:
    logging.error("Prophet library not found. Please install it (`pip install prophet` or `conda install -c conda-forge prophet`). Forecasting functionality will be disabled.")
    Prophet = None
except Exception as e:
    # Catch other potential import errors
    logging.error(f"An error occurred during Prophet import: {e}")
    Prophet = None


# --- Configuration ---
PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://localhost:9090")

# Define multiple PromQL queries for forecasting key metrics
# Using descriptive names for easier identification
PROMQL_QUERIES = {
    "Customer API Error Rate Signal": 'rate(bank_bank_early_warning_signals_total{service_name="customer-api-service", route="POST:/api/accounts/10002/deposit", signal="ERROR_RATE_APPROACHING_THRESHOLD"}[5m])',
    "Transaction Service Error Rate Signal": 'rate(bank_bank_early_warning_signals_total{service_name="transaction-service", route="POST:/api/transactions", signal="ERROR_RATE_APPROACHING_THRESHOLD"}[5m])',
    "Transaction Service 500 Errors": 'rate(bank_http_server_duration_milliseconds_count{service_name="transaction-service", http_status_code="500", route="POST:/api/transactions"}[5m])',
    "Customer API Withdrawal p99 Latency": 'bank_bank_baseline_latency_seconds{service_name="customer-api-service", route="POST:/api/accounts/10002/withdrawal", p99="0.0509"}', # Note: This is a gauge, rate() is not needed
    "Cross-Service Latency (Customer->Transaction)": 'sum(rate(bank_bank_cross_service_latency_seconds_sum{service_name="transaction-service", route="POST:/api/transactions", source="customer-api-service"}[5m])) / sum(rate(bank_bank_cross_service_latency_seconds_count{service_name="transaction-service", route="POST:/api/transactions", source="customer-api-service"}[5m]))',
    "Customer API Deposit p50 Latency (ms)": 'sum(rate(bank_http_server_duration_milliseconds_sum{service_name="customer-api-service", route="POST:/api/accounts/10001/deposit", http_status_code="200"}[5m])) / sum(rate(bank_http_server_duration_milliseconds_count{service_name="customer-api-service", route="POST:/api/accounts/10001/deposit", http_status_code="200"}[5m]))',
    "Customer API Active Users": 'bank_bank_active_users{service_name="customer-api-service"}', # Note: This is a gauge
    "Transaction Service Rate": 'rate(bank_bank_transactions_total{service_name="transaction-service", route="POST:/api/transactions"}[5m])'
}

# Default query (used if no specific target is provided by Grafana or if target is invalid)
DEFAULT_QUERY_NAME = "Customer API Error Rate Signal"
DEFAULT_PROMQL_QUERY = PROMQL_QUERIES[DEFAULT_QUERY_NAME]

PROMQL_QUERY_STEP = os.getenv("PROMQL_QUERY_STEP", "1m") # Default 1 minute step
FORECAST_PERIODS = int(os.getenv("FORECAST_PERIODS", 60)) # Number of steps to forecast
FORECAST_FREQ = os.getenv("FORECAST_FREQ", PROMQL_QUERY_STEP) # Frequency of forecast points, align with step

# Thresholds for anomaly detection
LATENCY_THRESHOLD_SECONDS = 0.1  # Flag latency > 100ms as potential issue
LATENCY_THRESHOLD_MILLISECONDS = LATENCY_THRESHOLD_SECONDS * 1000
ERROR_RATE_THRESHOLD = 0.1  # Flag error rate > 0.1 errors/second (rate metrics)
USER_LOAD_THRESHOLD = 100  # Flag active users > 100 as potential overload (gauge)
TRANSACTION_RATE_THRESHOLD = 50  # Flag transaction rate > 50/second (rate metric)

# --- FastAPI Application Setup ---
app = FastAPI(title="Prometheus Prophet Forecasting Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)

# --- Helper Function to Fetch Data from Prometheus ---
def fetch_prometheus_data(query: str, start_time: datetime, end_time: datetime, step: str) -> List[List[Union[int, str]]]:
    """Fetches data from Prometheus query_range API."""
    query_range_url = f"{PROMETHEUS_URL}/api/v1/query_range"
    # Ensure start and end times are timezone-aware (UTC) before getting timestamp
    start_ts = int(start_time.replace(tzinfo=timezone.utc).timestamp())
    end_ts = int(end_time.replace(tzinfo=timezone.utc).timestamp())

    params = {"query": query, "start": start_ts, "end": end_ts, "step": step}
    logging.info(f"Fetching data: URL={query_range_url}, Params={params}")
    start_fetch_time = time.time()
    try:
        response = requests.get(query_range_url, params=params, timeout=30) # 30 second timeout
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        data = response.json()

        if data.get("status") == "success":
            result = data.get("data", {}).get("result", [])
            if not result:
                logging.warning(f"No data returned for query: {query}")
                return []
            # Assuming the query returns a single time series for simplicity
            # More robust handling might check result type (matrix, vector)
            if len(result) > 1:
                 logging.warning(f"Query returned multiple time series ({len(result)}), using the first one: {query}")
            values = result[0].get("values", [])
            fetch_duration = time.time() - start_fetch_time
            logging.info(f"Fetched {len(values)} data points for query '{query}' in {fetch_duration:.2f}s.")
            # Prometheus returns [timestamp, value_string]
            return values
        else:
            logging.error(f"Prometheus query failed with status '{data.get('status')}': {data.get('errorType')} - {data.get('error')}")
            return []
    except requests.exceptions.Timeout:
        logging.error(f"Timeout error querying Prometheus ({query_range_url}) for query: {query}")
        return []
    except requests.exceptions.RequestException as e:
        logging.error(f"Error querying Prometheus ({query_range_url}): {e}")
        return []
    except json.JSONDecodeError as e:
        logging.error(f"Error decoding JSON response from Prometheus: {e}. Response text: {response.text[:500]}...") # Log part of the response
        return []

# --- Helper Function to Prepare Data for Prophet ---
def prepare_prophet_data(prometheus_values: List[List[Union[int, str]]]) -> pd.DataFrame:
    """Converts Prometheus data list to a Pandas DataFrame suitable for Prophet."""
    if not prometheus_values:
        logging.warning("No Prometheus data to prepare.")
        return pd.DataFrame()

    data_list = []
    for ts_epoch, val_str in prometheus_values:
        try:
            # Convert epoch timestamp to timezone-aware datetime (UTC)
            timestamp_dt = datetime.fromtimestamp(float(ts_epoch), tz=timezone.utc)
            value = float(val_str)
            # Handle potential NaN or Inf values from Prometheus calculations
            if not np.isfinite(value):
                 logging.warning(f"Skipping non-finite data point: [{ts_epoch}, {val_str}]")
                 continue
            data_list.append({'ds': timestamp_dt, 'y': value})
        except (ValueError, TypeError) as e:
            logging.warning(f"Skipping data point due to conversion error: [{ts_epoch}, {val_str}] - {e}")

    if not data_list:
        logging.warning("No valid data points after conversion.")
        return pd.DataFrame()

    try:
        df = pd.DataFrame(data_list)
        # Ensure 'ds' is datetime type and 'y' is numeric
        df['ds'] = pd.to_datetime(df['ds'], utc=True)
        df['y'] = pd.to_numeric(df['y']) # Already float, but good practice

        # Prophet requires at least 2 data points
        if len(df) < 2:
            logging.warning(f"Not enough data points ({len(df)}) for Prophet after preparation. Need at least 2.")
            return pd.DataFrame()

        df.sort_values(by='ds', inplace=True)
        # Check for and remove duplicate timestamps if necessary
        df.drop_duplicates(subset=['ds'], keep='last', inplace=True)

        logging.info(f"Prepared DataFrame with {len(df)} data points for Prophet.")
        return df

    except Exception as e:
        logging.error(f"Error creating or processing DataFrame: {e}")
        return pd.DataFrame()


# --- Helper Function to Train Prophet Model and Generate Forecast ---
def train_and_forecast(dataframe: pd.DataFrame, periods: int, freq: str) -> pd.DataFrame:
    """Trains a Prophet model and generates a forecast."""
    if Prophet is None:
        logging.error("Prophet library is not loaded. Cannot perform forecasting.")
        return pd.DataFrame()
    if dataframe.empty or len(dataframe) < 2:
        logging.warning("Cannot train Prophet: DataFrame is empty or has fewer than 2 data points.")
        return pd.DataFrame()

    logging.info(f"Training Prophet model on {len(dataframe)} data points...")
    start_train_time = time.time()
    try:
        # Initialize Prophet model
        # Adjust parameters based on expected data patterns if needed
        m = Prophet(
            # seasonality_mode='additive', # Default
            # daily_seasonality=True,     # Often useful for monitoring metrics
            # weekly_seasonality=True,    # Often useful
            # yearly_seasonality=False,   # Less common for short-term operational metrics
            changepoint_prior_scale=0.05 # Default, adjust if over/underfitting trend changes
        )

        # Fit the model
        m.fit(dataframe[['ds', 'y']]) # Only needs ds and y columns

        # Create future dataframe
        # `periods` is the number of steps *into the future*
        # `freq` should match the Prometheus step for consistency
        future = m.make_future_dataframe(
            periods=periods,
            freq=freq
        )

        # Generate forecast
        logging.info(f"Generating forecast for {periods} periods with frequency '{freq}'...")
        forecast = m.predict(future)
        train_duration = time.time() - start_train_time
        logging.info(f"Prophet training and forecasting completed in {train_duration:.2f}s.")

        # Return relevant columns
        return forecast[['ds', 'yhat', 'yhat_lower', 'yhat_upper']]

    except Exception as e:
        logging.error(f"Error during Prophet model training or forecasting: {e}", exc_info=True) # Log traceback
        return pd.DataFrame()

# --- Helper Function to Detect Anomalies in Forecast ---
def detect_anomalies(forecast_df: pd.DataFrame, query_name: str, promql_query: str) -> List[Dict[str, Any]]:
    """Detects anomalies in the forecast based on predefined thresholds."""
    anomalies = []
    if forecast_df.empty:
        return anomalies

    # Try to extract service_name for better context
    api_name = "unknown"
    try:
        if 'service_name="' in promql_query:
            start_idx = promql_query.find('service_name="') + len('service_name="')
            end_idx = promql_query.find('"', start_idx)
            if start_idx > -1 and end_idx > start_idx:
                api_name = promql_query[start_idx:end_idx]
    except Exception as e:
        logging.warning(f"Could not parse service_name from query '{promql_query}': {e}")

    logging.info(f"Detecting anomalies for metric: '{query_name}'")
    detected_count = 0
    
    # Calculate trend and acceleration
    if len(forecast_df) >= 3:
        values = forecast_df['yhat'].values
        trend = np.diff(values)
        acceleration = np.diff(trend)
        forecast_df['trend'] = np.append(trend, [trend[-1]])
        forecast_df['acceleration'] = np.append(acceleration, [acceleration[-1], acceleration[-1]])

    for _, row in forecast_df.iterrows():
        value = row['yhat']
        timestamp = row['ds']
        lower_bound = row['yhat_lower']
        upper_bound = row['yhat_upper']
        
        # Calculate confidence interval width
        ci_width = upper_bound - lower_bound
        confidence_level = 1 - (ci_width / (2 * value)) if value != 0 else 0

        # Create base anomaly structure
        base_anomaly = {
            "timestamp": timestamp.isoformat().replace('+00:00', 'Z'),
            "api": api_name,
            "metric_name": query_name,
            "promql_query": promql_query,
            "forecast_value": round(value, 4),
            "lower_bound": round(lower_bound, 4),
            "upper_bound": round(upper_bound, 4),
            "confidence_level": round(confidence_level, 2),
            "threshold": None,
            "type": "N/A",
            "severity": "info",
            "trend": None,
            "acceleration": None
        }

        # Add trend and acceleration if available
        if 'trend' in row and 'acceleration' in row:
            base_anomaly['trend'] = round(row['trend'], 4)
            base_anomaly['acceleration'] = round(row['acceleration'], 4)

        anomaly_detected = False
        lname = query_name.lower()
        lquery = promql_query.lower()

        if "latency" in lname or "duration" in lname:
            is_ms = "milliseconds" in lquery
            threshold = LATENCY_THRESHOLD_MILLISECONDS if is_ms else LATENCY_THRESHOLD_SECONDS
            unit = "ms" if is_ms else "s"
            if value > threshold:
                base_anomaly["threshold"] = threshold
                base_anomaly["type"] = f"High Latency ({unit})"
                base_anomaly["severity"] = "warning" if value < threshold * 1.5 else "critical"
                anomaly_detected = True
        elif "error rate" in lname or "500 errors" in lname or "early_warning_signals" in lquery:
            is_rate = "rate(" in lquery or "_total" in lquery
            if is_rate and value > ERROR_RATE_THRESHOLD:
                base_anomaly["threshold"] = ERROR_RATE_THRESHOLD
                base_anomaly["type"] = "High Error Rate"
                base_anomaly["severity"] = "warning" if value < ERROR_RATE_THRESHOLD * 2 else "critical"
                anomaly_detected = True
        elif "active users" in lname:
            if value > USER_LOAD_THRESHOLD:
                base_anomaly["threshold"] = USER_LOAD_THRESHOLD
                base_anomaly["type"] = "High User Load"
                base_anomaly["severity"] = "warning" if value < USER_LOAD_THRESHOLD * 1.2 else "critical"
                anomaly_detected = True
        elif "transaction rate" in lname or "transactions_total" in lquery:
            is_rate = "rate(" in lquery or "_total" in lquery
            if is_rate and value > TRANSACTION_RATE_THRESHOLD:
                base_anomaly["threshold"] = TRANSACTION_RATE_THRESHOLD
                base_anomaly["type"] = "High Transaction Rate"
                base_anomaly["severity"] = "warning" if value < TRANSACTION_RATE_THRESHOLD * 1.5 else "critical"
                anomaly_detected = True

        # Add trend-based predictions
        if anomaly_detected and 'trend' in base_anomaly and 'acceleration' in base_anomaly:
            trend = base_anomaly['trend']
            acceleration = base_anomaly['acceleration']
            
            if trend > 0 and acceleration > 0:
                base_anomaly["prediction"] = "Increasing rapidly"
            elif trend > 0 and acceleration <= 0:
                base_anomaly["prediction"] = "Increasing but slowing"
            elif trend < 0 and acceleration < 0:
                base_anomaly["prediction"] = "Decreasing rapidly"
            elif trend < 0 and acceleration >= 0:
                base_anomaly["prediction"] = "Decreasing but slowing"
            else:
                base_anomaly["prediction"] = "Stable"

        if anomaly_detected:
            anomalies.append(base_anomaly)
            detected_count += 1
            logging.warning(f"Anomaly detected: {base_anomaly['type']} at {base_anomaly['timestamp']}")
            logging.warning(f"Forecasted value: {base_anomaly['forecast_value']}, Threshold: {base_anomaly['threshold']}")
            logging.warning(f"Confidence: {base_anomaly['confidence_level']}, Severity: {base_anomaly['severity']}")
            if 'prediction' in base_anomaly:
                logging.warning(f"Trend prediction: {base_anomaly['prediction']}")

    logging.info(f"Detected {detected_count} potential anomalies for metric '{query_name}'.")
    return anomalies


# --- Grafana SimpleJSON Data Source Model Definitions ---
class SimpleJsonTarget(BaseModel):
    target: str # This will be the *name* of the query selected by the user
    refId: Optional[str] = None
    type: Optional[str] = 'timeserie' # Default, Grafana might send 'table'

class SimpleJsonRange(BaseModel):
    from_time: datetime = Field(..., alias='from') # Handle 'from' keyword
    to_time: datetime = Field(..., alias='to')
    # raw: Optional[Dict[str, str]] = None # Raw time range strings

class SimpleJsonQueryPayload(BaseModel):
    # app: Optional[str] = None
    # requestId: Optional[str] = None
    # timezone: Optional[str] = None
    panelId: Optional[int] = None
    # dashboardId: Optional[int] = None
    range: SimpleJsonRange
    # interval: Optional[str] = None
    intervalMs: Optional[int] = None
    targets: List[SimpleJsonTarget]
    maxDataPoints: Optional[int] = None # Useful for adjusting Prometheus step if needed
    # scopedVars: Optional[Dict[str, Any]] = None
    # startTime: Optional[int] = None
    # endTime: Optional[int] = None
    # adhocFilters: Optional[List[Any]] = None
    format: Optional[str] = 'json' # Default for SimpleJson

class SimpleJsonAnnoPayload(BaseModel):
     range: SimpleJsonRange
     annotation: Dict[str, Any] # Contains name, datasource, enable, query etc.


# --- FastAPI Endpoint Implementations ---

@app.get("/")
async def read_root():
    """Root endpoint for health check."""
    logging.info("Root endpoint '/' accessed.")
    return {"message": "Prometheus Prophet Forecasting Backend is running."}

@app.post("/search")
async def search_targets(request: Request):
    """Returns the list of available metric *names* for Grafana's query editor."""
    # The '/search' endpoint should return a list of strings representing the options
    # for the 'target' field in the '/query' request.
    logging.info("'/search' endpoint called.")
    # Return the descriptive names (keys of the dictionary)
    available_metrics = list(PROMQL_QUERIES.keys())
    return available_metrics

@app.post("/query")
async def query_data(payload: SimpleJsonQueryPayload):
    """Handles Grafana's data query requests."""
    logging.info(f"Received Grafana '/query' request for panel {payload.panelId}.")
    response_data = []
    all_anomalies = []

    start_time_utc = payload.range.from_time.replace(tzinfo=timezone.utc)
    end_time_utc = payload.range.to_time.replace(tzinfo=timezone.utc)

    # Add more detailed logging for time range
    logging.info(f"Query time range: {start_time_utc} to {end_time_utc}")

    step = PROMQL_QUERY_STEP

    for target in payload.targets:
        target_name = target.target
        promql_query = PROMQL_QUERIES.get(target_name)

        if not promql_query:
            logging.warning(f"Invalid target name '{target_name}' received. Using default query.")
            target_name = DEFAULT_QUERY_NAME
            promql_query = DEFAULT_PROMQL_QUERY

        logging.info(f"Processing target: '{target_name}' (Query: '{promql_query}')")

        # 1. Fetch historical data from Prometheus
        historical_values = fetch_prometheus_data(promql_query, start_time_utc, end_time_utc, step)

        if not historical_values:
            logging.error(f"No historical data found for '{target_name}'. This could be due to:")
            logging.error(f"1. Prometheus not running at {PROMETHEUS_URL}")
            logging.error(f"2. No metrics matching the query: {promql_query}")
            logging.error(f"3. Time range {start_time_utc} to {end_time_utc} has no data")
            
            # Add empty series with error information
            response_data.extend([
                {
                    "target": f"{target_name} - Historical",
                    "datapoints": [],
                    "error": "No historical data available. Check Prometheus connection and query."
                },
                {
                    "target": f"{target_name} - Forecast",
                    "datapoints": [],
                    "error": "Cannot generate forecast without historical data."
                },
                {
                    "target": f"{target_name} - Forecast Lower",
                    "datapoints": [],
                    "error": "Cannot generate forecast without historical data."
                },
                {
                    "target": f"{target_name} - Forecast Upper",
                    "datapoints": [],
                    "error": "Cannot generate forecast without historical data."
                }
            ])
            continue

        # 2. Prepare data for Prophet
        historical_df = prepare_prophet_data(historical_values)

        if historical_df.empty:
            logging.error(f"Could not prepare data for Prophet for '{target_name}'. This could be due to:")
            logging.error(f"1. Invalid data format in Prometheus response")
            logging.error(f"2. All data points are NaN or infinite")
            logging.error(f"3. Less than 2 valid data points available")
            
            # Add empty series with error information
            response_data.extend([
                {
                    "target": f"{target_name} - Historical",
                    "datapoints": [],
                    "error": "Data preparation failed. Check data format and quality."
                },
                {
                    "target": f"{target_name} - Forecast",
                    "datapoints": [],
                    "error": "Cannot generate forecast with invalid data."
                },
                {
                    "target": f"{target_name} - Forecast Lower",
                    "datapoints": [],
                    "error": "Cannot generate forecast with invalid data."
                },
                {
                    "target": f"{target_name} - Forecast Upper",
                    "datapoints": [],
                    "error": "Cannot generate forecast with invalid data."
                }
            ])
            continue

        # 3. Train Prophet model and generate forecast
        if Prophet is None:
            logging.error("Prophet library not available. Please install it with: pip install prophet")
            forecast_df = pd.DataFrame()
        else:
            # Calculate periods needed for forecast
            last_hist_dt = historical_df['ds'].iloc[-1]
            if end_time_utc > last_hist_dt:
                time_diff = end_time_utc - last_hist_dt
                try:
                    freq_offset = pd.tseries.frequencies.to_offset(FORECAST_FREQ)
                    periods_needed = max(1, int(np.ceil(time_diff / freq_offset.delta)) + 5)
                    periods_to_forecast = max(FORECAST_PERIODS, periods_needed)
                    logging.info(f"Forecasting {periods_to_forecast} periods for '{target_name}'")
                except ValueError:
                    logging.error(f"Invalid FORECAST_FREQ '{FORECAST_FREQ}'")
                    periods_to_forecast = FORECAST_PERIODS
            else:
                periods_to_forecast = FORECAST_PERIODS

            forecast_df = train_and_forecast(historical_df, periods=periods_to_forecast, freq=FORECAST_FREQ)

        # 4. Format forecast data for Grafana
        if not forecast_df.empty:
            last_historical_ts = historical_df['ds'].iloc[-1]
            forecast_datapoints = []
            lower_bound_datapoints = []
            upper_bound_datapoints = []

            future_forecast_df = forecast_df[
                (forecast_df['ds'] > last_historical_ts) &
                (forecast_df['ds'] >= start_time_utc) &
                (forecast_df['ds'] <= end_time_utc)
            ].copy()

            # Ensure non-negative values for rate metrics
            if "rate" in target_name.lower() or "count" in target_name.lower():
                future_forecast_df['yhat'] = future_forecast_df['yhat'].clip(lower=0)
                future_forecast_df['yhat_lower'] = future_forecast_df['yhat_lower'].clip(lower=0)
                future_forecast_df['yhat_upper'] = future_forecast_df['yhat_upper'].clip(lower=0)

            for _, row in future_forecast_df.iterrows():
                timestamp_ms = int(row['ds'].timestamp() * 1000)
                forecast_datapoints.append([float(row['yhat']), timestamp_ms])
                lower_bound_datapoints.append([float(row['yhat_lower']), timestamp_ms])
                upper_bound_datapoints.append([float(row['yhat_upper']), timestamp_ms])

            response_data.extend([
                {"target": f"{target_name} - Forecast", "datapoints": forecast_datapoints},
                {"target": f"{target_name} - Forecast Lower", "datapoints": lower_bound_datapoints},
                {"target": f"{target_name} - Forecast Upper", "datapoints": upper_bound_datapoints}
            ])

            # 5. Detect anomalies
            target_anomalies = detect_anomalies(future_forecast_df, target_name, promql_query)
            all_anomalies.extend(target_anomalies)

            # Log predicted error times
            for anomaly in target_anomalies:
                logging.warning(f"Predicted {anomaly['type']} for {target_name} at {anomaly['timestamp']}")
                logging.warning(f"Forecasted value: {anomaly['forecast_value']}, Threshold: {anomaly['threshold']}")
                logging.warning(f"Confidence interval: [{anomaly['lower_bound']}, {anomaly['upper_bound']}]")

        else:
            logging.error(f"Forecast generation failed for '{target_name}'")
            response_data.extend([
                {
                    "target": f"{target_name} - Forecast",
                    "datapoints": [],
                    "error": "Forecast generation failed. Check Prophet configuration."
                },
                {
                    "target": f"{target_name} - Forecast Lower",
                    "datapoints": [],
                    "error": "Forecast generation failed. Check Prophet configuration."
                },
                {
                    "target": f"{target_name} - Forecast Upper",
                    "datapoints": [],
                    "error": "Forecast generation failed. Check Prophet configuration."
                }
            ])

    logging.info(f"Returning {len(response_data)} timeseries datasets to Grafana.")
    return response_data


# --- Grafana Annotation Endpoint (Optional but Recommended for Anomalies) ---
@app.post("/annotations")
async def query_annotations(payload: SimpleJsonAnnoPayload):
    """Handles Grafana's annotation query requests."""
    logging.info(f"Received Grafana '/annotations' request for: {payload.annotation.get('name')}")

    # This endpoint can re-run the forecast calculation or use cached results
    # to generate annotation events based on detected anomalies.

    # For simplicity, let's re-run the forecast and anomaly detection for the requested time range
    # Note: The annotation query might specify a different query string or rely on the dashboard context.
    # We'll assume it wants anomalies for *all* configured metrics within the time range.

    all_annotations = []
    start_time_utc = payload.range.from_time.replace(tzinfo=timezone.utc)
    end_time_utc = payload.range.to_time.replace(tzinfo=timezone.utc) # Annotation range usually matches panel

    # Determine the historical data range needed to forecast *into* the annotation range
    # We need data *before* the start time to make forecasts *at* the start time.
    # Let's fetch data for a period before the start time (e.g., 1 day)
    # The amount of history needed depends on seasonality and trend; 1 day is a basic start.
    hist_duration_needed = timedelta(days=1) # Adjust as needed based on forecast period and data patterns
    hist_start_time = start_time_utc - hist_duration_needed
    hist_end_time = end_time_utc # Fetch history up to the end of the annotation range

    step = PROMQL_QUERY_STEP

    # In a real scenario, you might filter based on payload.annotation['query']
    # if it contains specific metrics to check. Here we check all.
    for target_name, promql_query in PROMQL_QUERIES.items():
        logging.debug(f"Checking anomalies for annotations: '{target_name}'")

        # 1. Fetch data (wider historical range)
        historical_values = fetch_prometheus_data(promql_query, hist_start_time, hist_end_time, step)
        if not historical_values:
            logging.debug(f"No historical data for annotations for '{target_name}'")
            continue
        # 2. Prepare data
        historical_df = prepare_prophet_data(historical_values)
        if historical_df.empty:
            logging.debug(f"Could not prepare data for annotations for '{target_name}'")
            continue
        # 3. Forecast
        if Prophet is None:
            logging.debug("Prophet not available, skipping annotation forecast.")
            continue

        # Forecast enough periods to cover the annotation range from the last historical point
        last_hist_dt = historical_df['ds'].iloc[-1]
        periods_to_forecast = 0 # Default
        if end_time_utc > last_hist_dt:
            time_diff = end_time_utc - last_hist_dt
            try:
                 freq_offset = pd.tseries.frequencies.to_offset(FORECAST_FREQ)
                 # Calculate periods needed to reach end_time_utc, plus buffer
                 periods_needed = max(1, int(np.ceil(time_diff / freq_offset.delta)) + 5) # Add small buffer
                 periods_to_forecast = periods_needed # Forecast at least enough periods to cover the range
                 logging.debug(f"Annotation forecast periods needed for {target_name}: {periods_needed}")
            except ValueError:
                 logging.warning(f"Could not parse FORECAST_FREQ '{FORECAST_FREQ}', skipping annotation forecast for '{target_name}'.")
                 continue # Cannot determine needed periods

        if periods_to_forecast > 0:
             forecast_df = train_and_forecast(historical_df, periods=periods_to_forecast, freq=FORECAST_FREQ)
        else:
             logging.debug(f"No future periods needed for annotation range for '{target_name}'.")
             forecast_df = pd.DataFrame() # No forecast needed

        if forecast_df.empty:
             logging.debug(f"Forecast dataframe empty for annotations for '{target_name}'.")
             continue

        # 4. Detect anomalies *within the Grafana requested time range*
        last_historical_ts = historical_df['ds'].iloc[-1]
        # Focus only on the future part of the forecast relevant to the annotation range
        future_forecast_in_range = forecast_df[
            (forecast_df['ds'] > last_historical_ts) &
            (forecast_df['ds'] >= start_time_utc) &
            (forecast_df['ds'] <= end_time_utc)
        ]

        if future_forecast_in_range.empty:
             logging.debug(f"No future forecast points found in annotation range for '{target_name}'.")
             continue

        target_anomalies = detect_anomalies(future_forecast_in_range, target_name, promql_query)

        # 5. Format anomalies as Grafana annotations
        for anomaly in target_anomalies:
             annotation_event = {
                 "annotation": payload.annotation, # Reference back to the query config
                 "time": int(datetime.fromisoformat(anomaly['timestamp'].replace('Z', '+00:00')).timestamp() * 1000), # Time in ms epoch
                 "title": f"Anomaly: {anomaly['type']}",
                 "tags": [
                     anomaly['api'], # Tag by API/Service
                     anomaly['metric_name'], # Tag by Metric
                     "forecast" # General tag
                 ],
                 "text": f"Metric: {anomaly['metric_name']}\n" \
                         f"API: {anomaly['api']}\n" \
                         f"Forecasted Value: {anomaly['forecast_value']:.4f}\n" \
                         f"Threshold: {anomaly['threshold']}\n" \
                         f"Confidence: ({anomaly['lower_bound']:.4f} - {anomaly['upper_bound']:.4f})"
             }
             all_annotations.append(annotation_event)


    logging.info(f"Returning {len(all_annotations)} annotation events to Grafana.")
    return all_annotations


# --- Main execution ---
# This part is typically used for local development runs
# In production, you'd use a ASGI server like uvicorn or hypercorn directly
# e.g., uvicorn predict:app --host 0.0.0.0 --port 8000 --workers 4
# --- Main execution ---
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8088))
    logging.info(f"Starting FastAPI server on port {port}")
    if Prophet is None:
        logging.warning("Prophet library not found. Forecasting features will be disabled.")
    # *** IT MUST BE "__main__:app" HERE ***
    uvicorn.run("__main__:app", host="0.0.0.0", port=port, reload=True)