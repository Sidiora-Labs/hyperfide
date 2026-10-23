import {
  getHostPathComparisonKey,
  isHostPathWithin,
  isWindowsHostPath,
} from "@hyperfide/domain";
import type Database from "better-sqlite3";
import { eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

function hostPathComparisonKeyForSql(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return getHostPathComparisonKey(value) ?? value;
}

function hostPathContainsForSql(
  rootPath: unknown,
  candidatePath: unknown,
): number {
  if (typeof rootPath !== "string" || typeof candidatePath !== "string") {
    return 0;
  }
  if (isWindowsHostPath(candidatePath)) {
    return isHostPathWithin({ rootPath, candidatePath }) ? 1 : 0;
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`)
    ? 1
    : 0;
}

export function registerHostPathSqlFunctions(sqlite: Database.Database): void {
  sqlite.function(
    "hyperfide_host_path_key",
    { deterministic: true },
    hostPathComparisonKeyForSql,
  );
  sqlite.function(
    "hyperfide_host_path_contains",
    { deterministic: true },
    hostPathContainsForSql,
  );
}

export function hostPathEquals(column: SQLiteColumn, path: string): SQL {
  return isWindowsHostPath(path)
    ? sql`hyperfide_host_path_key(${column}) = ${getHostPathComparisonKey(path) ?? path}`
    : eq(column, path);
}

export function hostPathContains(column: SQLiteColumn, path: string): SQL {
  return sql`hyperfide_host_path_contains(${column}, ${path}) = 1`;
}
