import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// zcode 的供应商定义在 ~/.zcode/v2/config.json 的 provider 字段里,
// model_usage.provider_id 就是它的 key(UUID 或 builtin:xxx)
const configFile =
  process.env.ZCODE_CONFIG_PATH ?? path.join(os.homedir(), ".zcode", "v2", "config.json");

// 配置文件里已不存在的旧 provider_id(如迁移前的 ark-coding-plan)手动给个可读名
const FALLBACK_ALIASES: Record<string, string> = {
  "ark-coding-plan": "火山方舟 Coding Plan",
};

/** providerId -> 展示名;读不到配置或未收录的 id 由调用方回退为原始 id。只取名称,不外泄 apiKey 等字段 */
export function loadProviderNames(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
      provider?: Record<string, { name?: unknown }>;
    };
    const names: Record<string, string> = { ...FALLBACK_ALIASES };
    for (const [id, p] of Object.entries(raw.provider ?? {})) {
      if (typeof p?.name === "string" && p.name) names[id] = p.name;
    }
    return names;
  } catch {
    return { ...FALLBACK_ALIASES };
  }
}
