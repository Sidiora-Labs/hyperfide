import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type Database from "better-sqlite3";
import type * as schema from "./schema.js";

type BaseConnection = BaseSQLiteDatabase<
  "async",
  Database.RunResult,
  typeof schema
>;
type BaseTransaction = Parameters<
  Parameters<BaseConnection["transaction"]>[0]
>[0];
interface Transactional {
  transaction<T>(
    work: (tx: DbTransaction) => T | Promise<T>,
    config?: { behavior?: "deferred" | "immediate" | "exclusive" },
  ): Promise<T>;
}
export type DbTransaction = Omit<BaseTransaction, "transaction"> &
  Transactional & { readonly dialect: "sqlite" | "postgresql" };
export type DbConnection = Omit<BaseConnection, "transaction"> &
  Transactional & {
    $client: Database.Database;
    dialect: "sqlite" | "postgresql";
    databaseUrl?: string;
    close(): Promise<void>;
  };
export type DbQueryConnection = DbConnection | DbTransaction;
const contexts = new AsyncLocalStorage<Array<() => unknown>>();
export function afterCommit(
  _db: DbQueryConnection,
  callback: () => unknown,
): void {
  const callbacks = contexts.getStore();
  if (callbacks) callbacks.push(callback);
  else callback();
}
export async function withCommitCallbacks<T>(
  work: () => Promise<T>,
): Promise<T> {
  const parent = contexts.getStore();
  const callbacks: Array<() => unknown> = [];
  const result = await contexts.run(callbacks, work);
  if (parent) parent.push(...callbacks);
  else
    for (const callback of callbacks) {
      try {
        await callback();
      } catch {}
    }
  return result;
}

// Query builders remain lazy. Only terminal operations cross the async boundary.
export function asyncBuilder(
  value: any,
  schedule: (work: () => any) => Promise<any> = async (work) => work(),
): any {
  if (!value || typeof value !== "object") return value;
  return new Proxy(value, {
    get(target, key) {
      if (key === "constructor") return target.constructor;
      if (key === "then")
        return typeof target.then === "function"
          ? (resolve: any, reject: any) =>
              schedule(() => target.execute()).then(resolve, reject)
          : undefined;
      const member = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      if (["all", "get", "run", "execute"].includes(String(key))) {
        return (...args: unknown[]) =>
          schedule(() => member.apply(target, args));
      }
      return (...args: unknown[]) =>
        asyncBuilder(member.apply(target, args), schedule);
    },
  });
}
