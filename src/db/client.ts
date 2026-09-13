import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

declare global {
  // eslint-disable-next-line no-var
  var __zarnishonSql: ReturnType<typeof postgres> | undefined;
}

// One pool across hot reloads in development.
export const sql = globalThis.__zarnishonSql ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalThis.__zarnishonSql = sql;

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema };
