import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const dbPath =
  process.env.ZCODE_DB_PATH ?? path.join(os.homedir(), ".zcode/cli/db/db.sqlite");

// 只读打开 zcode 的库,zcode 自身运行不受影响(WAL 模式下并发读安全)
export const db = new DatabaseSync(dbPath, { readOnly: true });

export const DB_PATH = dbPath;
