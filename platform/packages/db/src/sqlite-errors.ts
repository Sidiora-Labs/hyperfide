interface SqliteUniqueConstraintColumnsArgs {
  columnNames: readonly string[];
  indexName: string;
  tableName: string;
}

function getSqliteErrorCode(error: Error): string | null {
  if (error.cause instanceof Error) return getSqliteErrorCode(error.cause);
  const code = "code" in error ? error.code : null;
  return typeof code === "string" ? code : null;
}

function isSqliteUniqueConstraintError(error: Error): boolean {
  return getSqliteErrorCode(error) === "SQLITE_CONSTRAINT_UNIQUE";
}

export function isSqliteUniqueConstraintOnColumns(
  error: Error,
  args: SqliteUniqueConstraintColumnsArgs,
): boolean {
  if (getSqliteErrorCode(error) === "23505") {
    const cause = error.cause instanceof Error ? error.cause : error;
    return (
      ("constraint" in cause && cause.constraint === args.indexName) ||
      cause.message.includes(args.indexName)
    );
  }
  if (!isSqliteUniqueConstraintError(error)) {
    return false;
  }

  const qualifiedColumns = args.columnNames
    .map((columnName) => `${args.tableName}.${columnName}`)
    .join(", ");
  return (
    error.message === `UNIQUE constraint failed: ${qualifiedColumns}` ||
    error.message.includes(args.indexName)
  );
}

export function isSqliteForeignKeyConstraint(error: Error): boolean {
  return (
    getSqliteErrorCode(error) === "23503" ||
    getSqliteErrorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
    error.message.includes("FOREIGN KEY constraint failed")
  );
}
