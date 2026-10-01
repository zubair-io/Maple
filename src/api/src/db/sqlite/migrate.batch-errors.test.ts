import { expect, test } from 'bun:test';
import { createBlankTestDatabase } from './test-sqlite.test-helpers.ts';
import { fromBunSqlite, runMigrations } from './migrate.ts';

test('an intermediate constraint failure stops the batch and rolls back its migration', async () => {
  using handle = createBlankTestDatabase();
  handle.db.run('CREATE TABLE existing (value TEXT)');
  handle.db.run("INSERT INTO existing VALUES ('a'), ('a')");
  const migration = {
    id: '0001-failing-batch',
    async up(db: typeof handle.migrationDb) {
      await db.exec(`
        CREATE TABLE intermediate (value TEXT);
        INSERT INTO intermediate VALUES ('created');
        CREATE UNIQUE INDEX duplicate_values ON existing (value);
        CREATE TABLE wrongly_continued (value TEXT);
      `);
    },
  };
  await expect(runMigrations(handle.migrationDb, [migration])).rejects.toThrow(/UNIQUE constraint/);
  expect(
    handle.db
      .query(
        "SELECT name FROM sqlite_master WHERE name IN ('intermediate', 'duplicate_values', 'wrongly_continued')",
      )
      .all(),
  ).toEqual([]);
  expect(handle.db.query('SELECT * FROM existing').all()).toEqual([{ value: 'a' }, { value: 'a' }]);
  expect(handle.db.query('SELECT id FROM schema_migrations').all()).toEqual([]);
});

test('a direct batch never executes statements after a failed write', () => {
  using handle = createBlankTestDatabase();
  handle.db.run('CREATE TABLE values_table (value TEXT UNIQUE)');
  expect(() =>
    handle.migrationDb.exec(
      "INSERT INTO values_table VALUES ('first'); INSERT INTO values_table VALUES ('first'); INSERT INTO values_table VALUES ('after failure');",
    ),
  ).toThrow(/UNIQUE/);
  expect(handle.db.query('SELECT value FROM values_table').all()).toEqual([{ value: 'first' }]);
});

test('trigger bodies, comments and quoted semicolons keep SQLite statement boundaries', () => {
  using handle = createBlankTestDatabase();
  handle.migrationDb.exec(`
    -- comment ; CREATE TABLE ignored (x);
    CREATE TABLE "source;table" (value TEXT);
    /* comment ; */ CREATE TABLE [log;table] (value TEXT);
    CREATE TRIGGER "trigger;name" AFTER INSERT ON "source;table" BEGIN
      INSERT INTO [log;table] VALUES (CASE WHEN NEW.value = 'é;''quoted' THEN 'first;line' ELSE 'other' END);
      INSERT INTO [log;table] VALUES ('second;line');
    END;
    INSERT INTO "source;table" VALUES ('é;''quoted');
    ; /* trailing ; */ -- end
  `);
  expect(handle.db.query('SELECT value FROM [log;table] ORDER BY rowid').all()).toEqual([
    { value: 'first;line' },
    { value: 'second;line' },
  ]);
  expect(handle.db.query("SELECT name FROM sqlite_master WHERE name = 'ignored'").all()).toEqual(
    [],
  );
});

test('empty/comment-only batches are harmless and malformed later SQL rolls back', async () => {
  using handle = createBlankTestDatabase();
  for (const sql of ['', ' ; ; ', '-- only a comment', '/* semicolon ; */', '/* until EOF']) {
    handle.migrationDb.exec(sql);
  }
  await expect(
    runMigrations(handle.migrationDb, [
      {
        id: '0001-malformed',
        up(db) {
          db.exec(
            'CREATE TABLE before_error (value TEXT); THIS IS NOT SQL; CREATE TABLE after_error (x);',
          );
        },
      },
    ]),
  ).rejects.toThrow(/syntax error/);
  expect(
    handle.db
      .query("SELECT name FROM sqlite_master WHERE name IN ('before_error', 'after_error')")
      .all(),
  ).toEqual([]);
  expect(handle.db.query('SELECT id FROM schema_migrations').all()).toEqual([]);
});

test('exec does not silently substitute NULL for missing parameters', () => {
  using handle = createBlankTestDatabase();
  handle.db.run('CREATE TABLE values_table (value TEXT)');
  expect(() => handle.migrationDb.exec('INSERT INTO values_table VALUES (?);')).toThrow(
    /unbound parameters/,
  );
  expect(handle.db.query('SELECT * FROM values_table').all()).toEqual([]);
  handle.migrationDb.run('INSERT INTO values_table VALUES (?)', ['bound;value']);
  expect(handle.db.query('SELECT * FROM values_table').all()).toEqual([{ value: 'bound;value' }]);
});

test('each prepared statement is finalized even when its execution fails', () => {
  using handle = createBlankTestDatabase();
  handle.db.run('CREATE TABLE values_table (value TEXT UNIQUE)');
  const finalized: string[] = [];
  const db = fromBunSqlite({
    prepare(sql) {
      const statement = handle.db.prepare(sql);
      const parsed = statement.toString();
      return {
        paramsCount: statement.paramsCount,
        toString: () => parsed,
        run: () => statement.run(),
        finalize: () => {
          finalized.push(parsed);
          statement.finalize();
        },
      };
    },
    query: (sql) => handle.db.query(sql),
    run: (sql, params) => handle.db.run(sql, params),
  });
  const sql = "INSERT INTO values_table VALUES ('one');";
  expect(() => db.exec(sql + sql)).toThrow(/UNIQUE/);
  expect(finalized).toEqual([sql, sql]);
});
