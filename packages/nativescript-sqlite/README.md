# @edusperoni/nativescript-sqlite

A high-performance SQLite plugin for NativeScript. All database operations run on background threads via GCD — the JavaScript thread is never blocked.

**Platform support:** iOS (Android planned)

## Features

- Fully asynchronous — all queries dispatch to native background threads
- Connection pool with WAL mode — concurrent reads, serialized writes
- Write and read transactions with savepoint (nested transaction) support
- Prepared statements
- Two result formats: objects (`select`) or columnar arrays (`selectArray`)
- Synchronous API available for simple use cases (migrations, setup)
- Custom SQLite builds supported via CocoaPods

## Installation

```bash
npm install @edusperoni/nativescript-sqlite
```

## Quick Start

```typescript
import { openDatabase } from '@edusperoni/nativescript-sqlite';
import { knownFolders } from '@nativescript/core';

const db = openDatabase({
  path: knownFolders.documents().path + '/mydb.sqlite',
});

// Create a table
await db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    age INTEGER
  )
`);

// Insert data
await db.execute(
  'INSERT INTO users (name, email, age) VALUES (?, ?, ?)',
  ['Alice', 'alice@example.com', 30]
);

// Query rows (returns array of objects)
const users = await db.select('SELECT * FROM users WHERE age > ?', [25]);
// => [{ id: 1, name: "Alice", email: "alice@example.com", age: 30 }]

// Get a single row
const user = await db.get('SELECT * FROM users WHERE id = ?', [1]);
// => { id: 1, name: "Alice", ... } or undefined

// Clean up
db.close();
```

## API Reference

### `openDatabase(options): SQLiteDatabase`

Opens a database and returns a `SQLiteDatabase` instance. The connection pool is created immediately.

```typescript
const db = openDatabase({
  path: '/path/to/database.sqlite',
  readOnly: false,      // default: false
  poolSize: 4,          // number of reader connections, default: 4
  busyTimeout: 5000,    // milliseconds, default: 5000
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | *required* | Full path to the database file, or `":memory:"` |
| `readOnly` | `boolean` | `false` | Open in read-only mode |
| `poolSize` | `number` | `4` | Number of reader connections in the pool |
| `busyTimeout` | `number` | `5000` | Busy timeout in milliseconds |

### SQLiteDatabase

#### Async Methods

All async methods dispatch work to background threads and return Promises. Reads use reader connections from the pool; writes use the dedicated writer connection.

```typescript
// Execute a write statement (INSERT, UPDATE, DELETE, CREATE, etc.)
await db.execute(sql, params?);

// Query multiple rows as objects
const rows = await db.select<MyType>(sql, params?);

// Query multiple rows as columnar arrays (more efficient for large results)
const result = await db.selectArray(sql, params?);
// result.columns => ['id', 'name', 'age']
// result.rows    => [[1, 'Alice', 30], [2, 'Bob', 25]]

// Query a single row
const row = await db.get<MyType>(sql, params?);
```

#### Sync Methods

Synchronous methods block the JavaScript thread. They use a dedicated connection separate from the async pool. Use these for migrations, app setup, or when you need the result immediately and the query is fast.

```typescript
db.executeSync(sql, params?);
const rows = db.selectSync<MyType>(sql, params?);
const result = db.selectArraySync(sql, params?);
const row = db.getSync<MyType>(sql, params?);
```

#### Lifecycle

```typescript
db.isOpen;   // boolean
db.close();  // closes all connections, finalizes all prepared statements
```

### Parameters

Both positional and named parameters are supported.

**Positional parameters** use `?` placeholders:

```typescript
await db.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['Alice', 30]);
```

**Named parameters** use `:name`, `$name`, or `@name` placeholders and are passed as an object:

```typescript
await db.execute(
  'INSERT INTO users (name, age) VALUES (:name, :age)',
  { name: 'Alice', age: 30 }
);
```

The prefix (`:`, `$`, `@`) is added automatically if omitted — you can pass `{ name: 'Alice' }` instead of `{ ':name': 'Alice' }`.

**Supported value types:**

| JS Type | SQLite Type |
|---------|-------------|
| `string` | TEXT |
| `number` | INTEGER or REAL (auto-detected) |
| `boolean` | INTEGER (0 or 1) |
| `null` | NULL |
| `ArrayBuffer` | BLOB |

### Transactions

#### Write Transactions

Write transactions use the writer connection with `BEGIN IMMEDIATE`, ensuring an exclusive write lock from the start. They are serialized — concurrent calls to `transaction()` will queue automatically.

```typescript
const userId = await db.transaction(async (tx) => {
  await tx.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);
  const user = await tx.get('SELECT last_insert_rowid() as id');
  await tx.execute('INSERT INTO profiles (user_id, bio) VALUES (?, ?)', [user.id, 'Hello!']);
  return user.id;
});
```

If the callback throws, the transaction is rolled back. If it completes normally, it is committed. The return value of the callback is forwarded to the caller.

**Concurrent transactions** are safe — the second transaction's `BEGIN IMMEDIATE` queues behind the first's `COMMIT` on the writer's serial dispatch queue:

```typescript
// Both run, but writes are serialized
const [r1, r2] = await Promise.all([
  db.transaction(async (tx) => { /* ... */ }),
  db.transaction(async (tx) => { /* ... */ }),
]);
```

#### Read Transactions

Read transactions claim a dedicated reader connection for the duration of the transaction, providing a consistent snapshot.

```typescript
await db.readTransaction(async (tx) => {
  const users = await tx.select('SELECT * FROM users');
  const count = await tx.get('SELECT count(*) as n FROM orders');
  // Both queries see the same snapshot
});
```

Read transactions do not block the writer or other readers.

#### Nested Transactions (Savepoints)

Use `savepoint()` inside a write transaction:

```typescript
await db.transaction(async (tx) => {
  await tx.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);

  try {
    await tx.savepoint(async (sp) => {
      await sp.execute('INSERT INTO users (name) VALUES (?)', ['Bob']);
      throw new Error('changed my mind');
    });
  } catch {
    // Bob's insert is rolled back, Alice's is still pending
  }

  // Transaction commits with only Alice
});
```

### Prepared Statements

Prepared statements are compiled once and can be executed multiple times with different parameters. They are created on the writer connection.

```typescript
const stmt = await db.prepare('INSERT INTO users (name, age) VALUES (?, ?)');

await stmt.execute(['Alice', 30]);
await stmt.execute(['Bob', 25]);

const rows = await stmt.select(['Alice', 30]); // if it were a SELECT

await stmt.finalize(); // release native resources
```

Prepared statements are automatically finalized when the database is closed, but it is good practice to finalize them explicitly when no longer needed.

### `selectArray` — Columnar Result Format

`selectArray` returns column names once and rows as arrays of values. This is more efficient for large result sets since column names are not repeated per row.

```typescript
const result = await db.selectArray<[number, string, number]>(
  'SELECT id, name, age FROM users'
);

console.log(result.columns); // ['id', 'name', 'age']
for (const [id, name, age] of result.rows) {
  console.log(id, name, age);
}
```

Available on all contexts: `db.selectArray()`, `db.selectArraySync()`, `tx.selectArray()`, `stmt.selectArray()`.

### Error Handling

All errors are instances of `SQLiteError`, which extends `Error`:

```typescript
import { SQLiteError, SQLITE_CONSTRAINT } from '@edusperoni/nativescript-sqlite';

try {
  await db.execute('INSERT INTO users (id) VALUES (?)', [1]); // duplicate
} catch (e) {
  if (e instanceof SQLiteError) {
    console.log(e.message);      // human-readable error from sqlite3_errmsg
    console.log(e.code);         // sqlite3 result code (e.g. 19 for CONSTRAINT)
    console.log(e.extendedCode); // extended result code for more detail
  }
}
```

## Architecture

### Connection Pool

The plugin opens multiple SQLite connections to the same database file:

- **1 writer connection** — opened with `SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE`. All writes (`execute`, write transactions) dispatch to a serial GCD queue, ensuring only one write happens at a time.
- **N reader connections** — opened with `SQLITE_OPEN_READONLY`. Reads (`select`, `get`) are distributed across readers via round-robin, each with its own serial GCD queue. Multiple reads can run concurrently on different readers.
- **1 sync connection** — opened lazily on the first sync call. Used exclusively by `executeSync`/`selectSync`/`getSync` on the main thread.

WAL (Write-Ahead Logging) mode is enabled automatically on the writer. WAL allows readers to proceed without blocking writes, and writes to proceed without blocking readers.

### Performance

- All SQLite work (prepare, bind, step, column extraction) happens on background GCD threads.
- Results are serialized to a JSON string on the background thread. Only one value (the string) crosses the native-to-JS bridge. `JSON.parse` in V8 is highly optimized native C++ code.
- Blob columns are returned as separate `NSData` objects and converted to `ArrayBuffer` via `interop.bufferFromData` (no extra copy).
- The `selectArray` format avoids repeating column names per row, reducing both serialization cost and memory usage for large result sets.

## Custom SQLite Builds

By default, the plugin links against the system `libsqlite3` shipped with iOS. This SQLite version may lack features like the recovery extension, FTS5 tokenizer customization, or other compile-time options.

To use a custom SQLite build:

1. Add a SQLite pod to your app's `App_Resources/iOS/Podfile`:

```ruby
pod 'sqlite3', '~> 3.46.0'
# or a custom podspec with your own SQLite build
```

2. The pod's symbols will override the system SQLite at link time. No plugin code changes are needed — it calls the same C API functions regardless of the underlying implementation.

This is how you enable features like `sqlite3_recover_*` for database recovery.

## Type Definitions

```typescript
type SQLiteValue = string | number | boolean | null | ArrayBuffer;
type SQLiteParams = SQLiteValue[] | Record<string, SQLiteValue>;
type SQLiteRow = Record<string, SQLiteValue>;

interface SQLiteArrayResult<T extends SQLiteValue[] = SQLiteValue[]> {
  columns: string[];
  rows: T[];
}

interface DatabaseOptions {
  path: string;
  readOnly?: boolean;
  poolSize?: number;
  busyTimeout?: number;
}
```

## License

Apache License Version 2.0
