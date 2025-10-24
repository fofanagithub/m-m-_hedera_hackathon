import type { Request, Response } from "express";
import { Router } from "express";

import { mem, type Measurement } from "../db.js";

const r = Router();

function deriveMetric(kind: string, raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Number(raw);
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;

  if (kind === "traffic") {
    const candidates = [
      data.congestion,
      data.congestion_index,
      data.congestionIndex,
      data.avg_queue_len_NS,
      data.avg_queue_len_EW,
      data.queue_ns,
      data.queue_ew,
      data.queueNS,
      data.queueEW,
      data.avg_queue_len,
      data.queue,
    ]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (candidates.length) {
      return Math.max(...candidates);
    }

    const progress = Number(
      data.progress ?? data.flow ?? data.utilisation ?? data.utilization,
    );
    if (Number.isFinite(progress)) {
      return progress <= 1 ? progress * 100 : progress;
    }

    const waits = [
      data.wait_time_NS,
      data.wait_time_EW,
      data.wait_ns,
      data.wait_ew,
    ]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (waits.length) {
      return Math.max(...waits);
    }
  }

  if (kind === "rail") {
    const eta = Number(data.etaMs ?? data.eta_ms ?? data.eta);
    if (Number.isFinite(eta)) {
      return eta;
    }
  }

  return null;
}

function upsertRecent(kind: string, item: Measurement, keep = 200) {
  const bucket = mem.recent.get(kind) ?? [];
  bucket.push(item);
  if (bucket.length > keep) {
    bucket.splice(0, bucket.length - keep);
  }
  mem.recent.set(kind, bucket);

  const perLocation = mem.latestByLocation.get(kind) ?? new Map<string, Measurement>();
  perLocation.set(item.location, item);
  mem.latestByLocation.set(kind, perLocation);
}

function toSnapshotEntry(kind: string, entry: Measurement) {
  const metric =
    typeof entry.metric === "number" && Number.isFinite(entry.metric)
      ? entry.metric
      : deriveMetric(kind, entry.value);
  const numericMetric =
    typeof metric === "number" && Number.isFinite(metric) ? Number(metric) : null;
  return {
    location: entry.location,
    value: numericMetric ?? 0,
    metric: numericMetric,
    details: entry.value,
    ts: entry.ts,
  };
}

// POST /ingest {kind, location, value, ts?}
r.post("/", (req: Request, res: Response) => {
  const { kind, location, value, ts } = req.body || {};
  if (!kind || !location || typeof value === "undefined") {
    return res.status(400).json({ error: "kind, location, value required" });
  }

  const timestamp = typeof ts === "number" ? Number(ts) : Date.now();
  const metric = deriveMetric(kind, value);
  const item: Measurement = { kind, location, value, ts: timestamp };
  if (typeof metric === "number" && Number.isFinite(metric)) {
    item.metric = metric;
  }
  mem.measurements.push(item);
  upsertRecent(kind, item);
  return res.json({ ok: true, stored: item });
});

// GET /ingest/next?kind=traffic|rail (agents recover one measurement)
r.get("/next", (req: Request, res: Response) => {
  const kind = String(req.query.kind || "traffic");
  const idx = mem.measurements.findIndex((m) => m.kind === kind);
  if (idx === -1) {
    return res.json({ item: null });
  }
  const [item] = mem.measurements.splice(idx, 1);
  return res.json({ item });
});

// GET /ingest/snapshot?kind=traffic&limit=50 -> map-friendly payload
r.get("/snapshot", (req: Request, res: Response) => {
  const kind = String(req.query.kind || "traffic");
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50;

  const historyBucket = mem.recent.get(kind) ?? [];
  const history = historyBucket.slice(-limit).map((entry) => toSnapshotEntry(kind, entry));

  const latestMap = mem.latestByLocation.get(kind) ?? new Map<string, Measurement>();
  const latest = Array.from(latestMap.values()).map((entry) => toSnapshotEntry(kind, entry));

  return res.json({
    kind,
    updated: Date.now(),
    latest,
    history,
  });
});

export default r;
