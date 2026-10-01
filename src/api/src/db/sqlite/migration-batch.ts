export interface MigrationBatchConnection {
  prepare(sql: string): {
    readonly paramsCount: number;
    toString(): string;
    run(): unknown;
    finalize(): void;
  };
}

const LEADING_TRIVIA = /^(?:[ \t\r\n\f;]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/;

export function executeMigrationBatch(db: MigrationBatchConnection, sql: string): void {
  let remaining = sql;
  while (remaining.length > 0) {
    remaining = remaining.replace(LEADING_TRIVIA, '');
    if (remaining.length === 0) return;
    const statement = db.prepare(remaining);
    try {
      if (statement.paramsCount !== 0) {
        throw new Error('Migration exec has unbound parameters; use run with bindings');
      }
      // With no parameters, expanded SQL is the exact prefix parsed by SQLite, including a whole trigger body (#3951).
      const parsed = statement.toString();
      if (parsed.length === 0 || !remaining.startsWith(parsed)) {
        throw new Error('Cannot determine the prepared migration statement boundary');
      }
      statement.run();
      remaining = remaining.slice(parsed.length);
    } finally {
      statement.finalize();
    }
  }
}
