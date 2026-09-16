import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "./db";
import {
  getActivityHeatmap,
  getErrorStats,
  getLatencyStats,
  getModelStats,
  getProjectStats,
  getProviderStats,
  getRequestLog,
  getSummary,
  getToolStats,
  getTrend,
  getTrendByModel,
  getTrendByProvider,
} from "./queries";
import { loadPricing, savePricing } from "./pricing";
import type { PriceEntry, PricingMap } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "1mb" }));

function parseRange(q: Record<string, unknown>): { from?: number; to?: number } {
  const parse = (v: unknown) => {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return { from: parse(q.from), to: parse(q.to) };
}

app.get("/api/summary", (req, res) => {
  res.json(getSummary(parseRange(req.query as any)));
});

app.get("/api/trend", (req, res) => {
  res.json(getTrend(parseRange(req.query as any)));
});

app.get("/api/model-trend", (req, res) => {
  res.json(getTrendByModel(parseRange(req.query as any)));
});

app.get("/api/provider-trend", (req, res) => {
  res.json(getTrendByProvider(parseRange(req.query as any)));
});

app.get("/api/models", (req, res) => {
  res.json(getModelStats(parseRange(req.query as any)));
});

app.get("/api/projects", (req, res) => {
  res.json(getProjectStats(parseRange(req.query as any)));
});

app.get("/api/providers", (req, res) => {
  res.json(getProviderStats(parseRange(req.query as any)));
});

app.get("/api/requests", (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
  res.json(getRequestLog(parseRange(req.query as any), page, pageSize));
});

app.get("/api/tools", (req, res) => {
  res.json(getToolStats(parseRange(req.query as any)));
});

app.get("/api/errors", (req, res) => {
  res.json(getErrorStats(parseRange(req.query as any)));
});

app.get("/api/latency", (req, res) => {
  res.json(getLatencyStats(parseRange(req.query as any)));
});

app.get("/api/activity", (req, res) => {
  res.json(getActivityHeatmap(parseRange(req.query as any)));
});

app.get("/api/pricing", (_req, res) => {
  res.json(loadPricing());
});

app.put("/api/pricing", (req, res) => {
  const body = req.body as unknown;
  if (typeof body !== "object" || body == null) {
    res.status(400).json({ error: "body 必须是 PricingMap 对象" });
    return;
  }
  const clean: PricingMap = {};
  for (const [modelId, entry] of Object.entries(body as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry == null) continue;
    const e = entry as Partial<PriceEntry>;
    clean[modelId] = {
      input: Number(e.input) || 0,
      output: Number(e.output) || 0,
      cacheRead: Number(e.cacheRead) || 0,
      cacheWrite: Number(e.cacheWrite) || 0,
    };
  }
  savePricing(clean);
  res.json(clean);
});

app.get("/api/meta", (_req, res) => {
  res.json({ dbPath: DB_PATH });
});

// 生产模式:托管前端构建产物
if (process.env.NODE_ENV === "production") {
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && fs.existsSync(path.join(dist, "index.html"))) {
      res.sendFile(path.join(dist, "index.html"));
    } else {
      next();
    }
  });
}

app.listen(PORT, () => {
  console.log(`[agents-dashboard] API ready on http://localhost:${PORT}`);
  console.log(`[agents-dashboard] data source: ${DB_PATH}`);
});
