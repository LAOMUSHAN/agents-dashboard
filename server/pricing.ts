import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingMap } from "../shared/types";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const pricingFile = path.join(dataDir, "pricing.json");

// 内置的是估算价($/百万 token),仅供参考,请在界面里按实际价格修改
export const DEFAULT_PRICING: PricingMap = {
  "glm-5.3": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  "kimi-k3": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
  "x-preview-f-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function loadPricing(): PricingMap {
  try {
    const raw = fs.readFileSync(pricingFile, "utf8");
    return JSON.parse(raw) as PricingMap;
  } catch {
    savePricing(DEFAULT_PRICING);
    return { ...DEFAULT_PRICING };
  }
}

export function savePricing(map: PricingMap): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pricingFile, JSON.stringify(map, null, 2) + "\n", "utf8");
}
