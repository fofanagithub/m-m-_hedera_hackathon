FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    SUMO_HOME=/usr/share/sumo

RUN apt-get update \ 
 && apt-get install -y --no-install-recommends sumo sumo-tools ca-certificates \ 
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . /workspace

CMD ["python", "train/train_traffic.py", "--help"]
