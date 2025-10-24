FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
ENV MODEL_PATH=/models/traffic_policy.zip
ENV MODEL_METADATA_PATH=/models/traffic_policy.meta.json

EXPOSE 8100

CMD ["uvicorn", "src.infer_server:app", "--host", "0.0.0.0", "--port", "8100"]
