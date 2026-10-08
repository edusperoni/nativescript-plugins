import { knownFolders, File } from '@nativescript/core';
import { DemoSharedBase } from '../utils';
import { DatabaseOptions, OpenStep, openDatabase, SQLiteDatabase, SQLiteError, SQLITE_BUSY, SQLITE_CONSTRAINT, SQLITE_ERROR, SQLITE_MISUSE, SQLITE_NOTADB } from '@edusperoni/nativescript-sqlite';
import { runBenchmarks } from './benchmark';

export { runBenchmarks } from './benchmark';
export type { RunBenchmarksOptions } from './benchmark';

// ─── Tiny assertion helpers ────────────────────────────────────────────────────
function assert(condition: boolean, msg: string): asserts condition {
	if (!condition) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual<T>(actual: T, expected: T, msg: string) {
	if (actual !== expected) throw new Error(`ASSERT FAILED: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertApprox(actual: number, expected: number, tolerance: number, msg: string) {
	if (Math.abs(actual - expected) > tolerance) throw new Error(`ASSERT FAILED: ${msg} — expected ~${expected} ±${tolerance}, got ${actual}`);
}

/** Asserts that `path` cannot be read with `key` — the only engine-independent proof that a database really is encrypted. */
async function assertUnreadable(path: string, key: string | undefined, msg: string): Promise<void> {
	let db: SQLiteDatabase | undefined;
	try {
		db = openDatabase(key === undefined ? { path } : { path, encryptionKey: key });
		await db.select(`SELECT val FROM secret`);
	} catch (e) {
		return;
	} finally {
		if (db) await db.close().catch(() => undefined);
	}
	throw new Error(`ASSERT FAILED: ${msg}`);
}

function tempDb(name: string): string {
	const p = knownFolders.documents().path + `/${name}`;
	if (File.exists(p)) File.fromPath(p).remove();
	return p;
}

export class DemoSharedNativescriptSqlite extends DemoSharedBase {
	verbose = true;
	private log(...args: unknown[]) {
		if (this.verbose) console.log(...args);
	}

	// ── 1. Basic CRUD ──────────────────────────────────────────────────────────
	async testCRUD() {
		const TAG = '[CRUD]';
		const db = openDatabase({ path: tempDb('test_crud.db') });
		try {
			this.log(TAG, 'Creating table...');
			await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT NOT NULL)`);

			// INSERT
			this.log(TAG, 'Inserting rows: alpha, beta, gamma');
			await db.execute(`INSERT INTO t (val) VALUES (?)`, ['alpha']);
			await db.execute(`INSERT INTO t (val) VALUES (?)`, ['beta']);
			await db.execute(`INSERT INTO t (val) VALUES (?)`, ['gamma']);

			// SELECT all
			this.log(TAG, 'Selecting all rows...');
			const rows = await db.select<{ id: number; val: string }>(`SELECT * FROM t ORDER BY id`);
			assertEqual(rows.length, 3, 'row count');
			assertEqual(rows[0].val, 'alpha', 'row 0');
			assertEqual(rows[2].val, 'gamma', 'row 2');
			this.log(TAG, `  → got ${rows.length} rows:`, rows.map((r) => r.val).join(', '));

			// GET single
			this.log(TAG, "Getting single row where val='beta'...");
			const row = await db.get<{ id: number; val: string }>(`SELECT * FROM t WHERE val = ?`, ['beta']);
			assert(row != null, 'get returned null');
			assertEqual(row!.val, 'beta', 'get val');
			this.log(TAG, `  → id=${row!.id}, val=${row!.val}`);

			// UPDATE
			this.log(TAG, "Updating 'beta' → 'BETA'...");
			await db.execute(`UPDATE t SET val = ? WHERE val = ?`, ['BETA', 'beta']);
			const updated = await db.get<{ val: string }>(`SELECT val FROM t WHERE id = ?`, [row!.id]);
			assertEqual(updated!.val, 'BETA', 'updated val');
			this.log(TAG, `  → val is now: ${updated!.val}`);

			// DELETE
			this.log(TAG, "Deleting row where val='BETA'...");
			await db.execute(`DELETE FROM t WHERE val = ?`, ['BETA']);
			const after = await db.select(`SELECT * FROM t`);
			assertEqual(after.length, 2, 'rows after delete');
			this.log(TAG, `  → ${after.length} rows remain`);

			// GET on missing row returns undefined
			this.log(TAG, 'Getting non-existent row (id=9999)...');
			const missing = await db.get(`SELECT * FROM t WHERE id = 9999`);
			assertEqual(missing, undefined, 'missing row should be undefined');
			this.log(TAG, '  → correctly returned undefined');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 2. Data types: NULL, INTEGER, REAL, TEXT, BLOB ─────────────────────────
	async testDataTypes() {
		const TAG = '[DataTypes]';
		const db = openDatabase({ path: tempDb('test_types.db') });
		try {
			this.log(TAG, 'Creating table with INTEGER, REAL, TEXT, BLOB, NULL columns...');
			await db.execute(`CREATE TABLE types (
id     INTEGER PRIMARY KEY,
i      INTEGER,
r      REAL,
t      TEXT,
b      BLOB,
n      INTEGER
)`);

			this.log(TAG, 'Inserting row with all data types (i=42, r=3.14, t=hello, b=<4 bytes>, n=null)...');
			const blob = new Uint8Array([0x00, 0xff, 0x42, 0xab]).buffer as ArrayBuffer;
			await db.execute(`INSERT INTO types (i, r, t, b, n) VALUES (?, ?, ?, ?, ?)`, [42, 3.14, 'hello', blob, null]);

			this.log(TAG, 'Reading back and verifying types...');
			const row = await db.get<{ i: number; r: number; t: string; b: ArrayBuffer; n: null }>(`SELECT i, r, t, b, n FROM types WHERE id = 1`);

			assert(row != null, 'row is null');
			assertEqual(row!.i, 42, 'INTEGER');
			assertApprox(row!.r as number, 3.14, 0.0001, 'REAL');
			assertEqual(row!.t, 'hello', 'TEXT');
			assertEqual(row!.n, null, 'NULL');
			assert(row!.b instanceof ArrayBuffer, 'BLOB should be ArrayBuffer');
			const bytes = new Uint8Array(row!.b as ArrayBuffer);
			assertEqual(bytes[0], 0x00, 'BLOB byte 0');
			assertEqual(bytes[1], 0xff, 'BLOB byte 1');
			assertEqual(bytes[2], 0x42, 'BLOB byte 2');
			assertEqual(bytes[3], 0xab, 'BLOB byte 3');
			this.log(TAG, `  → INTEGER=${row!.i}, REAL=${row!.r}, TEXT=${row!.t}, NULL=${row!.n}, BLOB=${bytes.length} bytes ✓`);

			// boolean (stored as 0/1)
			this.log(TAG, 'Testing boolean coercion (true→1, false→0)...');
			await db.execute(`CREATE TABLE bools (v INTEGER)`);
			await db.execute(`INSERT INTO bools (v) VALUES (?)`, [true]);
			await db.execute(`INSERT INTO bools (v) VALUES (?)`, [false]);
			const bools = await db.select<{ v: number }>(`SELECT v FROM bools ORDER BY rowid`);
			assertEqual(bools[0].v, 1, 'true→1');
			assertEqual(bools[1].v, 0, 'false→0');
			this.log(TAG, `  → true=${bools[0].v}, false=${bools[1].v} ✓`);

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 3. Parameter binding: positional and named ─────────────────────────────
	async testParams() {
		const TAG = '[Params]';
		const db = openDatabase({ path: tempDb('test_params.db') });
		try {
			this.log(TAG, 'Inserting with positional params: [?, ?]...');
			await db.execute(`CREATE TABLE p (a TEXT, b INTEGER)`);
			await db.execute(`INSERT INTO p (a, b) VALUES (?, ?)`, ['pos', 1]);
			this.log(TAG, 'Inserting with named params (:name style)...');
			await db.execute(`INSERT INTO p (a, b) VALUES (:a, :b)`, { ':a': 'named_colon', ':b': 2 });
			this.log(TAG, 'Inserting with named params ($name style)...');
			await db.execute(`INSERT INTO p (a, b) VALUES ($a, $b)`, { $a: 'named_dollar', $b: 3 });
			this.log(TAG, 'Inserting with named params (@name style)...');
			await db.execute(`INSERT INTO p (a, b) VALUES (@a, @b)`, { '@a': 'named_at', '@b': 4 });

			this.log(TAG, 'Selecting and verifying all 4 rows...');
			const rows = await db.select<{ a: string; b: number }>(`SELECT a, b FROM p ORDER BY b`);
			assertEqual(rows.length, 4, 'param rows count');
			assertEqual(rows[0].a, 'pos', 'positional');
			assertEqual(rows[1].a, 'named_colon', 'named :');
			assertEqual(rows[2].a, 'named_dollar', 'named $');
			assertEqual(rows[3].a, 'named_at', 'named @');
			this.log(TAG, '  →', rows.map((r) => r.a).join(', '), '✓');

			this.log(TAG, 'Using named param in SELECT...');
			const r = await db.get<{ b: number }>(`SELECT b FROM p WHERE a = :a`, { ':a': 'named_colon' });
			assertEqual(r!.b, 2, 'named param in SELECT');
			this.log(TAG, `  → b=${r!.b} ✓`);

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 4. selectArray / getArray ──────────────────────────────────────────────
	async testSelectArray() {
		const TAG = '[SelectArray]';
		const db = openDatabase({ path: tempDb('test_array.db') });
		try {
			this.log(TAG, 'Inserting 3 rows...');
			await db.execute(`CREATE TABLE arr (x INTEGER, y TEXT)`);
			await db.execute(`INSERT INTO arr VALUES (1, 'a')`);
			await db.execute(`INSERT INTO arr VALUES (2, 'b')`);
			await db.execute(`INSERT INTO arr VALUES (3, 'c')`);

			this.log(TAG, 'selectArray — verifying columns and row arrays...');
			const result = await db.selectArray(`SELECT x, y FROM arr ORDER BY x`);
			assertEqual(result.columns.length, 2, 'column count');
			assertEqual(result.columns[0], 'x', 'col 0 name');
			assertEqual(result.columns[1], 'y', 'col 1 name');
			assertEqual(result.rows.length, 3, 'row count');
			assertEqual(result.rows[0][0] as number, 1, 'row0 col0');
			assertEqual(result.rows[0][1] as string, 'a', 'row0 col1');
			assertEqual(result.rows[2][0] as number, 3, 'row2 col0');
			this.log(TAG, `  → columns: [${result.columns}], rows: ${result.rows.length} ✓`);

			// getArray
			this.log(TAG, 'getArray — single row where x=2...');
			const single = await db.getArray(`SELECT x, y FROM arr WHERE x = ?`, [2]);
			assertEqual(single.rows.length, 1, 'getArray row count');
			assertEqual(single.rows[0][0] as number, 2, 'getArray value');
			this.log(TAG, `  → [${single.rows[0]}] ✓`);

			// getArray on missing returns empty rows
			this.log(TAG, 'getArray — missing row (x=999)...');
			const none = await db.getArray(`SELECT x FROM arr WHERE x = 999`);
			assertEqual(none.rows.length, 0, 'getArray missing rows');
			this.log(TAG, '  → empty result ✓');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 5. Transactions ────────────────────────────────────────────────────────
	async testTransactions() {
		const TAG = '[Transactions]';
		const db = openDatabase({ path: tempDb('test_tx.db') });
		try {
			this.log(TAG, 'Seeding accounts: id=1 balance=1000, id=2 balance=500...');
			await db.execute(`CREATE TABLE acct (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)`);
			await db.execute(`INSERT INTO acct VALUES (1, 1000)`);
			await db.execute(`INSERT INTO acct VALUES (2, 500)`);

			// Successful transaction
			this.log(TAG, 'Committing transaction: transfer 200 from id=1 to id=2...');
			await db.transaction(async (tx) => {
				await tx.execute(`UPDATE acct SET balance = balance - 200 WHERE id = 1`);
				await tx.execute(`UPDATE acct SET balance = balance + 200 WHERE id = 2`);
				const b1 = await tx.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 1`);
				assertEqual(b1!.balance, 800, 'mid-tx balance 1');
			});
			const b1After = await db.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 1`);
			assertEqual(b1After!.balance, 800, 'committed balance 1');
			this.log(TAG, `  → id=1 balance=${b1After!.balance} ✓`);

			// Failed transaction must rollback
			this.log(TAG, 'Rolling back transaction: deduct 200 from id=2 then throw...');
			try {
				await db.transaction(async (tx) => {
					await tx.execute(`UPDATE acct SET balance = balance - 200 WHERE id = 2`);
					throw new Error('deliberate rollback');
				});
			} catch (_) {
				/* expected */
			}
			const b2After = await db.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 2`);
			assertEqual(b2After!.balance, 700, 'rolled-back balance 2');
			this.log(TAG, `  → id=2 balance still ${b2After!.balance} (rollback preserved) ✓`);

			// readTransaction
			this.log(TAG, 'readTransaction — read-only select...');
			await db.readTransaction(async (tx) => {
				const rows = await tx.select<{ id: number }>(`SELECT id FROM acct ORDER BY id`);
				assertEqual(rows.length, 2, 'readTx row count');
				this.log(TAG, `  → ${rows.length} rows ✓`);
			});

			// Nested savepoint
			this.log(TAG, 'Savepoint: outer sets balance=9999, inner sets balance=1 then rolls back...');
			await db.transaction(async (tx) => {
				await tx.execute(`UPDATE acct SET balance = 9999 WHERE id = 1`);
				await tx
					.savepoint(async (inner) => {
						await inner.execute(`UPDATE acct SET balance = 1 WHERE id = 1`);
						throw new Error('savepoint rollback');
					})
					.catch(() => {
						/* expected */
					});
				// outer change should survive savepoint rollback
				const b = await tx.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 1`);
				assertEqual(b!.balance, 9999, 'outer change preserved after savepoint rollback');
				this.log(TAG, `  → id=1 balance=${b!.balance} (savepoint rollback did not affect outer tx) ✓`);
			});

			// Return value from transaction
			this.log(TAG, 'Returning a value from transaction...');
			const result = await db.transaction(async (tx) => {
				const r = await tx.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 2`);
				return r!.balance;
			});
			assertEqual(result, 700, 'transaction return value');
			this.log(TAG, `  → returned value: ${result} ✓`);

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 6. Prepared statements ─────────────────────────────────────────────────
	async testPreparedStatements() {
		const TAG = '[PreparedStatements]';
		const db = openDatabase({ path: tempDb('test_prep.db') });
		try {
			this.log(TAG, 'Seeding 3 rows (Alice, Bob, Carol)...');
			await db.execute(`CREATE TABLE prep (id INTEGER PRIMARY KEY, name TEXT, score REAL)`);
			await db.execute(`INSERT INTO prep VALUES (1, 'Alice', 9.5)`);
			await db.execute(`INSERT INTO prep VALUES (2, 'Bob', 7.0)`);
			await db.execute(`INSERT INTO prep VALUES (3, 'Carol', 8.25)`);

			// select
			this.log(TAG, 'Prepared select: score > 8.0...');
			const selStmt = await db.prepare(`SELECT name, score FROM prep WHERE score > ? ORDER BY score DESC`);
			const high = await selStmt.select<{ name: string; score: number }>([8.0]);
			assertEqual(high.length, 2, 'prep select count');
			assertEqual(high[0].name, 'Alice', 'prep select row 0');
			this.log(TAG, `  → ${high.map((r) => `${r.name}(${r.score})`).join(', ')} ✓`);
			// reuse with different params
			this.log(TAG, 'Re-using statement: score > 0 (all rows)...');
			const all3 = await selStmt.select<{ name: string }>([0]);
			assertEqual(all3.length, 3, 'prep select reuse');
			this.log(TAG, `  → ${all3.length} rows ✓`);
			await selStmt.finalize();

			// get
			this.log(TAG, 'Prepared get: id=2...');
			const getStmt = await db.prepare(`SELECT score FROM prep WHERE id = ?`);
			const r = await getStmt.get<{ score: number }>([2]);
			assertApprox(r!.score as number, 7.0, 0.001, 'prep get');
			this.log(TAG, `  → score=${r!.score} ✓`);
			const missing = await getStmt.get<{ score: number }>([999]);
			assertEqual(missing, undefined, 'prep get missing');
			this.log(TAG, '  → id=999 → undefined ✓');
			await getStmt.finalize();

			// selectArray
			this.log(TAG, 'Prepared selectArray: all rows...');
			const arrStmt = await db.prepare(`SELECT id, name, score FROM prep ORDER BY id`);
			const arr = await arrStmt.selectArray();
			assertEqual(arr.columns.length, 3, 'prep selectArray cols');
			assertEqual(arr.rows.length, 3, 'prep selectArray rows');
			this.log(TAG, `  → columns: [${arr.columns}], ${arr.rows.length} rows ✓`);
			await arrStmt.finalize();

			// getArray
			this.log(TAG, 'Prepared getArray: id=1...');
			const getArrStmt = await db.prepare(`SELECT name, score FROM prep WHERE id = ?`);
			const singleArr = await getArrStmt.getArray([1]);
			assertEqual(singleArr.rows.length, 1, 'prep getArray row');
			assertEqual(singleArr.rows[0][0] as string, 'Alice', 'prep getArray name');
			this.log(TAG, `  → [${singleArr.rows[0]}] ✓`);
			await getArrStmt.finalize();

			// execute (INSERT/UPDATE/DELETE)
			this.log(TAG, 'Prepared execute: inserting Dave and Eve...');
			const insStmt = await db.prepare(`INSERT INTO prep (id, name, score) VALUES (?, ?, ?)`);
			await insStmt.execute([4, 'Dave', 6.5]);
			await insStmt.execute([5, 'Eve', 9.9]);
			await insStmt.finalize();
			const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM prep`);
			assertEqual(count!.n, 5, 'rows after prepared inserts');
			this.log(TAG, `  → total rows: ${count!.n} ✓`);

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 7. Sync API ────────────────────────────────────────────────────────────
	async testSyncAPI() {
		const TAG = '[SyncAPI]';
		const db = openDatabase({ path: tempDb('test_sync.db') });
		try {
			this.log(TAG, 'executeSync: creating table and inserting rows...');
			db.executeSync(`CREATE TABLE sync_t (id INTEGER PRIMARY KEY, v TEXT)`);
			db.executeSync(`INSERT INTO sync_t VALUES (1, 'x')`);
			db.executeSync(`INSERT INTO sync_t VALUES (2, 'y')`);

			this.log(TAG, 'selectSync: all rows...');
			const rows = db.selectSync<{ id: number; v: string }>(`SELECT * FROM sync_t ORDER BY id`);
			assertEqual(rows.length, 2, 'selectSync count');
			assertEqual(rows[0].v, 'x', 'selectSync row 0');
			this.log(TAG, `  → ${rows.map((r) => r.v).join(', ')} ✓`);

			this.log(TAG, 'getSync: id=2...');
			const single = db.getSync<{ v: string }>(`SELECT v FROM sync_t WHERE id = ?`, [2]);
			assertEqual(single!.v, 'y', 'getSync');
			this.log(TAG, `  → v=${single!.v} ✓`);

			this.log(TAG, 'getSync: missing row...');
			const missing = db.getSync(`SELECT * FROM sync_t WHERE id = 999`);
			assertEqual(missing, undefined, 'getSync missing');
			this.log(TAG, '  → undefined ✓');

			this.log(TAG, 'selectArraySync...');
			const arr = db.selectArraySync(`SELECT id, v FROM sync_t ORDER BY id`);
			assertEqual(arr.columns.length, 2, 'selectArraySync cols');
			assertEqual(arr.rows.length, 2, 'selectArraySync rows');
			assertEqual(arr.columns[0], 'id', 'selectArraySync col name');
			this.log(TAG, `  → columns: [${arr.columns}], ${arr.rows.length} rows ✓`);

			// The query matches both rows, so this also pins getArraySync to one row
			// rather than letting it pass as an alias for selectArraySync.
			this.log(TAG, 'getArraySync on a query matching two rows...');
			const singleArr = db.getArraySync(`SELECT id, v FROM sync_t ORDER BY id`);
			assertEqual(singleArr.rows.length, 1, 'getArraySync should return the first row only');
			assertEqual(singleArr.rows[0][1] as string, 'x', 'getArraySync value');
			this.log(TAG, `  → [${singleArr.rows[0]}] ✓`);

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 8. Error handling ──────────────────────────────────────────────────────
	async testErrorHandling() {
		const TAG = '[ErrorHandling]';
		const db = openDatabase({ path: tempDb('test_err.db') });
		try {
			this.log(TAG, 'Setting up table with UNIQUE NOT NULL constraint...');
			await db.execute(`CREATE TABLE err (id INTEGER PRIMARY KEY, val TEXT UNIQUE NOT NULL)`);
			await db.execute(`INSERT INTO err VALUES (1, 'unique_val')`);

			// Bad SQL syntax
			this.log(TAG, 'Testing bad SQL syntax → should throw SQLiteError...');
			let threw = false;
			try {
				await db.execute(`THIS IS NOT SQL`);
			} catch (e) {
				threw = true;
				assert(e instanceof SQLiteError, 'bad SQL should throw SQLiteError');
				assert(typeof e.code === 'number', 'SQLiteError.code should be number');
				assert(e.message.length > 0, 'SQLiteError.message should be non-empty');
				this.log(TAG, `  → SQLiteError code=${e.code}: ${e.message} ✓`);
			}
			assert(threw, 'bad SQL should have thrown');

			// UNIQUE constraint violation
			this.log(TAG, 'Testing UNIQUE constraint violation...');
			threw = false;
			try {
				await db.execute(`INSERT INTO err VALUES (2, 'unique_val')`);
			} catch (e) {
				threw = true;
				assert(e instanceof SQLiteError, 'constraint violation should throw SQLiteError');
				assertEqual(e.code, SQLITE_CONSTRAINT, 'constraint error code');
				this.log(TAG, `  → SQLITE_CONSTRAINT (${e.code}) ✓`);
			}
			assert(threw, 'UNIQUE violation should have thrown');

			// NOT NULL constraint
			this.log(TAG, 'Testing NOT NULL constraint violation...');
			threw = false;
			try {
				await db.execute(`INSERT INTO err (id) VALUES (3)`);
			} catch (e) {
				threw = true;
				assert(e instanceof SQLiteError, 'NOT NULL violation should throw SQLiteError');
				this.log(TAG, `  → SQLiteError code=${(e as SQLiteError).code} ✓`);
			}
			assert(threw, 'NOT NULL violation should have thrown');

			// SELECT on non-existent table
			this.log(TAG, 'Testing SELECT on non-existent table...');
			threw = false;
			try {
				await db.select(`SELECT * FROM does_not_exist`);
			} catch (e) {
				threw = true;
				assert(e instanceof SQLiteError, 'missing table should throw SQLiteError');
				this.log(TAG, `  → SQLiteError: ${(e as SQLiteError).message} ✓`);
			}
			assert(threw, 'missing table should have thrown');

			// Operations after close
			this.log(TAG, 'Testing use-after-close...');
			const db2 = openDatabase({ path: tempDb('test_err2.db') });
			await db2.close();
			threw = false;
			try {
				await db2.execute(`SELECT 1`);
			} catch (e) {
				threw = true;
				this.log(TAG, '  → threw on closed db ✓');
			}
			assert(threw, 'use after close should throw');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 9. getRuntimeInfo ──────────────────────────────────────────────────────
	async testRuntimeInfo() {
		const TAG = '[RuntimeInfo]';
		const db = openDatabase({ path: tempDb('test_info.db') });
		try {
			const info = db.getRuntimeInfo();
			assert(typeof info.version === 'string' && info.version.length > 0, 'version string');
			assert(typeof info.sourceId === 'string', 'sourceId string');
			assert(Array.isArray(info.compileOptions), 'compileOptions array');
			this.log(TAG, `SQLite ${info.version} (${info.sourceId.substring(0, 12)}...)`);
			if (info.compileOptions.includes('EXTRA_INIT=sqlcipher_extra_init')) {
				console.log(TAG, 'SQLCipher support detected in SQLite runtime');
			}
			this.log(TAG, `Compile options (${info.compileOptions.length}):`, info.compileOptions.slice(0, 5).join(', '));
			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 10. In-memory database ─────────────────────────────────────────────────
	async testInMemoryDB() {
		const TAG = '[InMemory]';
		this.log(TAG, 'Opening :memory: database...');
		const db = openDatabase({ path: ':memory:' });
		try {
			assert(db.isOpen, 'isOpen should be true');
			this.log(TAG, `  → isOpen=${db.isOpen} ✓`);
			this.log(TAG, 'Creating table and inserting value 42...');
			await db.execute(`CREATE TABLE mem (x INTEGER)`);
			await db.execute(`INSERT INTO mem VALUES (42)`);
			this.log(TAG, 'Reading back value...');
			const r = await db.get<{ x: number }>(`SELECT x FROM mem`);
			assertEqual(r!.x, 42, 'in-memory value');
			this.log(TAG, `  → x=${r!.x} ✓`);
			this.log(TAG, 'Closing database...');
			await db.close();
			assert(!db.isOpen, 'isOpen should be false after close');
			this.log(TAG, `  → isOpen=${db.isOpen} after close ✓`);
			console.log(TAG, 'PASSED');
		} catch (e) {
			await db.close().catch(() => {});
			throw e;
		}
	}

	// ── 11. Low-level transaction API ──────────────────────────────────────────
	async testLowLevelTransactions() {
		const TAG = '[LowLevelTx]';
		const db = openDatabase({ path: tempDb('test_lltx.db') });
		try {
			await db.execute(`CREATE TABLE ll (id INTEGER PRIMARY KEY, v TEXT)`);

			// commit path
			this.log(TAG, 'beginTransaction(immediate) → insert → selectInTransaction → commit...');
			const txId = await db.beginTransaction('immediate');
			await db.executeInTransaction(txId, `INSERT INTO ll VALUES (1, 'committed')`);
			const mid = await db.selectInTransaction(txId, `SELECT v FROM ll WHERE id = 1`);
			assertEqual((mid[0] as { v: string }).v, 'committed', 'mid-tx select');
			this.log(TAG, `  → mid-tx read: ${(mid[0] as { v: string }).v} ✓`);
			await db.commitTransaction(txId);

			const after = await db.get<{ v: string }>(`SELECT v FROM ll WHERE id = 1`);
			assertEqual(after!.v, 'committed', 'committed value');
			this.log(TAG, `  → post-commit read: ${after!.v} ✓`);

			// rollback path
			this.log(TAG, 'beginTransaction → insert → rollback...');
			const txId2 = await db.beginTransaction();
			await db.executeInTransaction(txId2, `INSERT INTO ll VALUES (2, 'rolled_back')`);
			await db.rollbackTransaction(txId2);
			const gone = await db.get(`SELECT * FROM ll WHERE id = 2`);
			assertEqual(gone, undefined, 'rolled back row should be gone');
			this.log(TAG, '  → row gone after rollback ✓');

			// selectArrayInTransaction
			this.log(TAG, 'selectArrayInTransaction...');
			const txId3 = await db.beginTransaction();
			await db.executeInTransaction(txId3, `INSERT INTO ll VALUES (3, 'arr')`);
			const arrResult = await db.selectArrayInTransaction(txId3, `SELECT id, v FROM ll ORDER BY id`);
			assertEqual(arrResult.columns.length, 2, 'lltx selectArray cols');
			assert(arrResult.rows.length >= 1, 'lltx selectArray rows');
			this.log(TAG, `  → columns: [${arrResult.columns}], rows: ${arrResult.rows.length} ✓`);
			await db.commitTransaction(txId3);

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── Run all tests ──────────────────────────────────────────────────────────
	async testAll() {
		const prev = this.verbose;
		this.verbose = false;
		try {
			await this.testCRUD();
			await this.testDataTypes();
			await this.testParams();
			await this.testSelectArray();
			await this.testTransactions();
			await this.testPreparedStatements();
			await this.testSyncAPI();
			await this.testErrorHandling();
			await this.testRuntimeInfo();
			await this.testInMemoryDB();
			await this.testLowLevelTransactions();
			await this.testOnOpen();
			await this.testSerialized();
			await this.testKeyFormatValidation();
			await this.testSyncOnClosedDatabase();
			await this.testSingleWriterSync();
			await this.testSyncAsyncOrdering();
			await this.testSyncReentrancy();
			await this.testTransactionSyncMethods();
			await this.testTransactionSync();
			await this.testJoinTransaction();
			await this.testAsyncOpen();
			await this.testOpenSequenceValidation();
			await this.testOpenSequence();
			await this.testOpenSequenceWriterFirst();
			await this.testSQLCipher();
			await this.testKeyedOpenLatency();
			await this.testOpenSequenceBeforeKey();
			console.log('[ALL] All tests PASSED');
		} finally {
			this.verbose = prev;
		}
	}

	// ── 12. onOpen statements ─────────────────────────────────────────────────
	async testOnOpen() {
		const TAG = '[OnOpen]';
		// foreign_keys is per-connection and off by default, so reading it back
		// tells us which connections actually ran the statement.
		const db = openDatabase({ path: tempDb('test_onopen.db'), poolSize: 2, serialized: false, onOpen: ['PRAGMA foreign_keys=ON'] });
		try {
			this.log(TAG, 'Checking the writer connection...');
			await db.transaction(async (tx) => {
				const row = await tx.get<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
				assertEqual(row!.foreign_keys, 1, 'writer ran onOpen');
			});
			this.log(TAG, '  → writer ✓');

			this.log(TAG, 'Checking every reader connection...');
			for (let i = 0; i < 4; i++) {
				const row = await db.get<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
				assertEqual(row!.foreign_keys, 1, `reader ${i} ran onOpen`);
			}
			this.log(TAG, '  → readers ✓');

			this.log(TAG, 'Checking the sync connection...');
			const syncRow = db.getSync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
			assertEqual(syncRow!.foreign_keys, 1, 'sync connection ran onOpen');
			this.log(TAG, '  → sync ✓');
		} finally {
			await db.close();
		}

		this.log(TAG, 'A failing onOpen statement must abort the open...');
		let threw = false;
		try {
			openDatabase({ path: tempDb('test_onopen_fail.db'), onOpen: ['SELECT * FROM table_that_does_not_exist'] });
		} catch (e) {
			threw = true;
			assert(e instanceof SQLiteError, 'a failing onOpen should throw SQLiteError');
			this.log(TAG, `  → SQLiteError code=${(e as SQLiteError).code}: ${(e as SQLiteError).message} ✓`);
		}
		assert(threw, 'a failing onOpen statement should abort the open');
		console.log(TAG, 'PASSED');
	}

	// ── 13. Serialized mode ───────────────────────────────────────────────────
	async testSerialized() {
		const TAG = '[Serialized]';
		this.log(TAG, 'Opening a file database with serialized: true...');
		const db = openDatabase({ path: tempDb('test_serialized.db'), serialized: true });
		try {
			await db.execute(`CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)`);
			await db.execute(`INSERT INTO s VALUES (1, 'a')`);

			this.log(TAG, 'Reading with no reader pool...');
			const rows = await db.select<{ v: string }>(`SELECT v FROM s ORDER BY id`);
			assertEqual(rows.length, 1, 'serialized select');
			assertEqual(rows[0].v, 'a', 'serialized select value');

			this.log(TAG, 'Writing in a transaction...');
			await db.transaction(async (tx) => {
				await tx.execute(`INSERT INTO s VALUES (2, 'b')`);
				const seen = await tx.select(`SELECT v FROM s`);
				assertEqual(seen.length, 2, 'serialized read inside its own transaction');
			});

			this.log(TAG, 'Reading through the sync API...');
			const count = db.getSync<{ n: number }>(`SELECT COUNT(*) AS n FROM s`);
			assertEqual(count!.n, 2, 'serialized sync read');

			this.log(TAG, 'Running a prepared statement...');
			const stmt = await db.prepare(`SELECT v FROM s WHERE id = ?`);
			const prepared = await stmt.select<{ v: string }>([2]);
			assertEqual(prepared[0].v, 'b', 'serialized prepared statement');
			await stmt.finalize();

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 14. encryptionKeyFormat validation ────────────────────────────────────
	// Runs without a codec: the key is resolved in JavaScript before it reaches
	// SQLite.
	async testKeyFormatValidation() {
		const TAG = '[KeyFormat]';
		const rawHex = 'a'.repeat(64);

		this.log(TAG, 'A raw-shaped key without encryptionKeyFormat must be rejected...');
		let threw = false;
		try {
			openDatabase({ path: tempDb('test_keyfmt1.db'), encryptionKey: `x'${rawHex}'` });
		} catch (e) {
			threw = true;
			this.log(TAG, `  → ${(e as Error).message} ✓`);
		}
		assert(threw, "a key shaped like x'<hex>' should be rejected without encryptionKeyFormat: 'raw'");

		this.log(TAG, 'A raw key that is not 64 or 96 hex digits must be rejected...');
		threw = false;
		try {
			openDatabase({ path: tempDb('test_keyfmt2.db'), encryptionKey: 'not-hex', encryptionKeyFormat: 'raw' });
		} catch (e) {
			threw = true;
			this.log(TAG, `  → ${(e as Error).message} ✓`);
		}
		assert(threw, 'a malformed raw key should be rejected');

		console.log(TAG, 'PASSED');
	}

	// ── 15. Sync methods on a closed database ─────────────────────────────────
	async testSyncOnClosedDatabase() {
		const TAG = '[SyncClosed]';
		const db = openDatabase({ path: tempDb('test_syncclosed.db') });
		await db.close();

		const check = (name: string, call: () => unknown) => {
			let threw = false;
			let result: unknown;
			try {
				result = call();
			} catch (e) {
				threw = true;
			}
			// A rejected promise instead of a throw is the failure this guards
			// against; swallow it so it does not surface as an unhandled rejection.
			if (result && typeof (result as Promise<unknown>).then === 'function') {
				(result as Promise<unknown>).catch(() => {});
			}
			assert(threw, `${name} on a closed database must throw synchronously`);
			this.log(TAG, `  → ${name} threw ✓`);
		};

		check('executeSync', () => db.executeSync(`SELECT 1`));
		check('selectSync', () => db.selectSync(`SELECT 1`));
		check('selectArraySync', () => db.selectArraySync(`SELECT 1`));
		check('getSync', () => db.getSync(`SELECT 1`));
		check('getArraySync', () => db.getArraySync(`SELECT 1`));

		console.log(TAG, 'PASSED');
	}

	// ── 16. One writer shared by the sync and async APIs ──────────────────────
	async testSingleWriterSync() {
		const TAG = '[SingleWriter]';
		const db = openDatabase({ path: tempDb('test_singlewriter.db') });
		try {
			await db.execute(`CREATE TABLE w (id INTEGER PRIMARY KEY, v TEXT)`);

			await db.transaction(async (tx) => {
				await tx.execute(`INSERT INTO w VALUES (1, 'in-tx')`);

				this.log(TAG, 'A sync read must see the open transaction...');
				const seen = db.getSync<{ v: string }>(`SELECT v FROM w WHERE id = 1`);
				assertEqual(seen!.v, 'in-tx', 'sync read sees the uncommitted row');

				this.log(TAG, 'executeSync must be refused, and refused immediately...');
				const t0 = Date.now();
				let threw = false;
				try {
					db.executeSync(`INSERT INTO w VALUES (2, 'sync')`);
				} catch (e) {
					threw = true;
					assert(e instanceof SQLiteError, 'should throw SQLiteError');
					assertEqual((e as SQLiteError).code, SQLITE_BUSY, 'executeSync during a transaction should report SQLITE_BUSY');
				}
				const elapsed = Date.now() - t0;
				assert(threw, 'executeSync during a transaction should throw');
				assert(elapsed < 50, `executeSync should fail without waiting on the busy timeout, took ${elapsed}ms`);
				this.log(TAG, `  → refused in ${elapsed}ms ✓`);
			});

			this.log(TAG, 'After the commit executeSync works again...');
			db.executeSync(`INSERT INTO w VALUES (2, 'after')`);
			const count = db.getSync<{ n: number }>(`SELECT count(*) AS n FROM w`);
			assertEqual(count!.n, 2, 'both rows present after the transaction');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 17. Sync calls are ordered behind queued async work ───────────────────
	async testSyncAsyncOrdering() {
		const TAG = '[SyncOrdering]';
		const db = openDatabase({ path: tempDb('test_ordering.db') });
		try {
			await db.execute(`CREATE TABLE o (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)`);

			this.log(TAG, 'A sync read after 50 un-awaited writes must see all of them...');
			const pending: Promise<void>[] = [];
			for (let i = 0; i < 50; i++) pending.push(db.execute(`INSERT INTO o (v) VALUES (?)`, [i]));
			const mid = db.getSync<{ n: number }>(`SELECT count(*) AS n FROM o`);
			assertEqual(mid!.n, 50, 'sync read should queue behind the async writes');
			await Promise.all(pending);
			this.log(TAG, '  → saw all 50 ✓');

			this.log(TAG, 'Interleaved sync and async writes must not lose rows...');
			await db.execute(`DELETE FROM o`);
			const more: Promise<void>[] = [];
			for (let i = 0; i < 40; i++) {
				if (i % 2 === 0) db.executeSync(`INSERT INTO o (v) VALUES (?)`, [i]);
				else more.push(db.execute(`INSERT INTO o (v) VALUES (?)`, [i]));
			}
			await Promise.all(more);
			const total = db.getSync<{ n: number }>(`SELECT count(*) AS n FROM o`);
			assertEqual(total!.n, 40, 'interleaved writes all landed');
			this.log(TAG, '  → 40/40 ✓');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 18. Sync calls from inside continuations and callbacks ────────────────
	async testSyncReentrancy() {
		const TAG = '[SyncReentrancy]';
		const db = openDatabase({ path: tempDb('test_reentrancy.db') });
		try {
			await db.execute(`CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT)`);

			this.log(TAG, 'From inside an awaited continuation...');
			await db.execute(`INSERT INTO r VALUES (1, 'async')`);
			db.executeSync(`INSERT INTO r VALUES (2, 'sync-in-continuation')`);
			const row = db.getSync<{ v: string }>(`SELECT v FROM r WHERE id = 2`);
			assertEqual(row!.v, 'sync-in-continuation', 'sync write from a continuation');

			this.log(TAG, "From inside transaction()'s callback (reads only)...");
			await db.transaction(async (tx) => {
				await tx.execute(`INSERT INTO r VALUES (3, 'in-tx')`);
				const inTx = db.getSync<{ n: number }>(`SELECT count(*) AS n FROM r`);
				assertEqual(inTx!.n, 3, 'sync read inside a transaction callback');
			});

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 19. Sync methods on transaction objects ───────────────────────────────
	async testTransactionSyncMethods() {
		const TAG = '[TxSyncMethods]';
		const db = openDatabase({ path: tempDb('test_txsync.db') });
		try {
			await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);

			this.log(TAG, "A transaction's own sync methods see and change its state...");
			await db.transaction(async (tx) => {
				tx.executeSync(`INSERT INTO t VALUES (1, 'a')`);
				const seen = tx.getSync<{ v: string }>(`SELECT v FROM t WHERE id = 1`);
				assertEqual(seen!.v, 'a', 'tx.getSync sees tx.executeSync');
			});
			assertEqual((await db.get<{ v: string }>(`SELECT v FROM t WHERE id = 1`))!.v, 'a', 'committed');

			this.log(TAG, 'Their writes roll back with the transaction...');
			try {
				await db.transaction(async (tx) => {
					tx.executeSync(`INSERT INTO t VALUES (2, 'b')`);
					throw new Error('rollback please');
				});
			} catch (e) {
				/* expected */
			}
			assertEqual(await db.get(`SELECT v FROM t WHERE id = 2`), undefined, 'rolled back with the transaction');

			this.log(TAG, 'Using a transaction object after it finished must throw...');
			let escaped: any;
			await db.transaction(async (tx) => {
				escaped = tx;
			});
			let threw = false;
			try {
				escaped.executeSync(`INSERT INTO t VALUES (3, 'c')`);
			} catch (e) {
				threw = true;
				assert(e instanceof SQLiteError, 'finished transaction should throw SQLiteError');
				assertEqual((e as SQLiteError).code, SQLITE_MISUSE, 'finished transaction reports SQLITE_MISUSE');
			}
			assert(threw, 'a finished transaction object should refuse work');

			this.log(TAG, 'Low-level executeInTransactionSync / selectInTransactionSync...');
			const txId = await db.beginTransaction();
			db.executeInTransactionSync(txId, `INSERT INTO t VALUES (4, 'd')`);
			const rows = db.selectInTransactionSync(txId, `SELECT v FROM t WHERE id = 4`);
			assertEqual((rows[0] as { v: string }).v, 'd', 'selectInTransactionSync');
			const arr = db.selectArrayInTransactionSync(txId, `SELECT id, v FROM t WHERE id = 4`);
			assertEqual(arr.columns.length, 2, 'selectArrayInTransactionSync columns');
			await db.commitTransaction(txId);

			this.log(TAG, 'An unknown txId must throw...');
			threw = false;
			try {
				db.executeInTransactionSync(999999, `SELECT 1`);
			} catch (e) {
				threw = true;
				assertEqual((e as SQLiteError).code, SQLITE_MISUSE, 'unknown txId reports SQLITE_MISUSE');
			}
			assert(threw, 'an unknown txId should throw');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 20. transactionSync ───────────────────────────────────────────────────
	async testTransactionSync() {
		const TAG = '[TransactionSync]';
		const db = openDatabase({ path: tempDb('test_txsync_full.db') });
		try {
			await db.execute(`CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)`);

			this.log(TAG, 'Commit path, and the callback return value...');
			const returned = db.transactionSync((tx) => {
				tx.executeSync(`INSERT INTO s VALUES (1, 'one')`);
				return tx.getSync<{ v: string }>(`SELECT v FROM s WHERE id = 1`)!.v;
			});
			assertEqual(returned, 'one', 'transactionSync returns the callback value');
			assertEqual((await db.get<{ v: string }>(`SELECT v FROM s WHERE id = 1`))!.v, 'one', 'committed');

			this.log(TAG, 'A throw rolls back and rethrows the original error...');
			const sentinel = new Error('boom');
			let caught: unknown;
			try {
				db.transactionSync((tx) => {
					tx.executeSync(`INSERT INTO s VALUES (2, 'two')`);
					throw sentinel;
				});
			} catch (e) {
				caught = e;
			}
			assert(caught === sentinel, 'the original error is rethrown unchanged');
			assertEqual(await db.get(`SELECT v FROM s WHERE id = 2`), undefined, 'rolled back');

			this.log(TAG, 'An async callback must be rejected...');
			let threw = false;
			try {
				db.transactionSync((() => Promise.resolve(1)) as any);
			} catch (e) {
				threw = true;
				this.log(TAG, `  → ${(e as Error).message} ✓`);
			}
			assert(threw, 'a thenable-returning callback should throw');

			this.log(TAG, 'savepointSync rolls back its own work only...');
			db.transactionSync((tx) => {
				tx.executeSync(`INSERT INTO s VALUES (3, 'three')`);
				try {
					tx.savepointSync((sp) => {
						sp.executeSync(`INSERT INTO s VALUES (4, 'four')`);
						throw new Error('nested');
					});
				} catch (e) {
					/* expected */
				}
			});
			assert((await db.get(`SELECT v FROM s WHERE id = 3`)) != null, 'outer row survives');
			assertEqual(await db.get(`SELECT v FROM s WHERE id = 4`), undefined, 'savepoint row rolled back');

			this.log(TAG, 'Work dispatched inside the callback runs after it, not inside it...');
			let dispatched: Promise<void>;
			try {
				db.transactionSync((tx) => {
					tx.executeSync(`INSERT INTO s VALUES (5, 'five')`);
					dispatched = db.execute(`INSERT INTO s VALUES (6, 'six')`);
					throw new Error('rollback');
				});
			} catch (e) {
				/* expected */
			}
			await dispatched!;
			assertEqual(await db.get(`SELECT v FROM s WHERE id = 5`), undefined, "the sync transaction's own row is gone");
			assert((await db.get(`SELECT v FROM s WHERE id = 6`)) != null, 'the dispatched write ran outside the rolled-back transaction');
			this.log(TAG, '  → 5 rolled back, 6 kept ✓');

			this.log(TAG, 'Writes queued before it are visible inside it...');
			const queued = db.execute(`INSERT INTO s VALUES (7, 'seven')`);
			const sawSeven = db.transactionSync((tx) => tx.getSync(`SELECT v FROM s WHERE id = 7`) != null);
			await queued;
			assert(sawSeven, 'transactionSync waits behind writes queued before it');

			this.log(TAG, 'transactionSync during an open async transaction is refused, fast...');
			await db.transaction(async (tx) => {
				const t0 = Date.now();
				let refused = false;
				try {
					db.transactionSync(() => undefined);
				} catch (e) {
					refused = true;
					assertEqual((e as SQLiteError).code, SQLITE_BUSY, 'nested transactionSync reports SQLITE_BUSY');
				}
				const elapsed = Date.now() - t0;
				assert(refused, 'transactionSync inside a transaction should throw');
				assert(elapsed < 50, `should fail immediately, took ${elapsed}ms`);
			});

			this.log(TAG, 'The database is still usable after all of that...');
			db.executeSync(`INSERT INTO s VALUES (8, 'eight')`);
			await db.execute(`INSERT INTO s VALUES (9, 'nine')`);
			assert((await db.get(`SELECT v FROM s WHERE id = 8`)) != null, 'sync write after a failed sync transaction');
			assert((await db.get(`SELECT v FROM s WHERE id = 9`)) != null, 'async write after a failed sync transaction');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 21. executeSync({ joinTransaction }) ──────────────────────────────────
	async testJoinTransaction() {
		const TAG = '[JoinTransaction]';
		const db = openDatabase({ path: tempDb('test_join.db') });
		try {
			await db.execute(`CREATE TABLE j (id INTEGER PRIMARY KEY, v TEXT)`);

			this.log(TAG, 'Joining a transaction that commits...');
			await db.transaction(async () => {
				db.executeSync(`INSERT INTO j VALUES (1, 'joined')`, undefined, { joinTransaction: true });
			});
			assert((await db.get(`SELECT v FROM j WHERE id = 1`)) != null, 'joined write committed with the transaction');

			this.log(TAG, 'Joining a transaction that rolls back...');
			try {
				await db.transaction(async () => {
					db.executeSync(`INSERT INTO j VALUES (2, 'joined')`, undefined, { joinTransaction: true });
					throw new Error('rollback');
				});
			} catch (e) {
				/* expected */
			}
			assertEqual(await db.get(`SELECT v FROM j WHERE id = 2`), undefined, 'joined write rolled back with the transaction');

			this.log(TAG, 'With no transaction open it behaves like any other executeSync...');
			db.executeSync(`INSERT INTO j VALUES (3, 'plain')`, undefined, { joinTransaction: true });
			assert((await db.get(`SELECT v FROM j WHERE id = 3`)) != null, 'joinTransaction with no transaction open');

			console.log(TAG, 'PASSED');
		} finally {
			await db.close();
		}
	}

	// ── 22. Background opens, asyncOpen and initialized() ─────────────────────
	async testAsyncOpen() {
		const TAG = '[AsyncOpen]';

		this.log(TAG, 'asyncOpen returns immediately and initialized() resolves...');
		const t0 = Date.now();
		const db = openDatabase({ path: tempDb('test_asyncopen.db'), asyncOpen: true });
		const openMs = Date.now() - t0;
		try {
			assert(db.isOpen, 'isOpen should be true while still opening');
			assert(openMs < 50, `asyncOpen should return immediately, took ${openMs}ms`);
			await db.initialized();
			await db.execute(`CREATE TABLE a (x INTEGER)`);
			await db.execute(`INSERT INTO a VALUES (1)`);
			assertEqual((await db.get<{ x: number }>(`SELECT x FROM a`))!.x, 1, 'usable after initialized()');
			this.log(TAG, `  → openDatabase ${openMs}ms ✓`);
		} finally {
			await db.close();
		}

		this.log(TAG, 'A sync call before initialization blocks and then works...');
		const db2 = openDatabase({ path: tempDb('test_asyncopen2.db'), asyncOpen: true });
		try {
			db2.executeSync(`CREATE TABLE b (x INTEGER)`);
			db2.executeSync(`INSERT INTO b VALUES (7)`);
			assertEqual(db2.getSync<{ x: number }>(`SELECT x FROM b`)!.x, 7, 'sync path waited for the open');
		} finally {
			await db2.close();
		}

		// Awaiting initialized() is documented as optional, so a read issued before
		// the connections are open has to queue rather than be turned away.
		this.log(TAG, 'A pooled read issued before initialization, without awaiting it...');
		const db3 = openDatabase({ path: tempDb('test_asyncopen3.db'), asyncOpen: true, poolSize: 2 });
		try {
			await db3.execute(`CREATE TABLE c (x INTEGER)`);
			await db3.execute(`INSERT INTO c VALUES (3)`);
			const rows = await db3.select<{ x: number }>(`SELECT x FROM c`);
			assertEqual(rows.length, 1, 'read issued before initialization should queue, not fail');
			assertEqual(rows[0].x, 3, 'and return the right row');
		} finally {
			await db3.close();
		}

		this.log(TAG, 'Opening and closing immediately, 50 times...');
		for (let i = 0; i < 50; i++) {
			const d = openDatabase({ path: tempDb('test_asyncopen_loop.db'), asyncOpen: true });
			await d.close();
		}
		this.log(TAG, '  → no crash ✓');

		console.log(TAG, 'PASSED');
	}

	// ── 23. Encryption (needs a SQLite built with a codec) ────────────────────
	async testSQLCipher() {
		const TAG = '[SQLCipher]';
		const path = tempDb('test_cipher.db');
		const key = 'secret-key-123';

		// Open encrypted database and write data
		this.log(TAG, `Opening encrypted database with key '${key}'...`);
		const db = openDatabase({ path, encryptionKey: key });
		try {
			assert(db.isOpen, 'encrypted db should be open');
			this.log(TAG, 'Creating table and inserting encrypted row...');
			await db.execute(`CREATE TABLE secret (id INTEGER PRIMARY KEY, val TEXT)`);
			await db.execute(`INSERT INTO secret VALUES (1, 'hidden')`);
			this.log(TAG, '  → written; closing...');
		} finally {
			await db.close();
		}

		// Reopen with correct key — data must survive
		this.log(TAG, 'Reopening with correct key and verifying data persists...');
		const db2 = openDatabase({ path, encryptionKey: key });
		try {
			const row = await db2.get<{ val: string }>(`SELECT val FROM secret WHERE id = 1`);
			assert(row != null, 'row should exist after reopen');
			assertEqual(row!.val, 'hidden', 'encrypted value survives close/reopen');
			this.log(TAG, `  → val='${row!.val}' ✓`);
		} finally {
			await db2.close();
		}

		// The file must be unreadable without the key. Without this the test would
		// also pass against a SQLite with no codec, which accepts `PRAGMA key` and
		// writes plaintext.
		this.log(TAG, 'Reopening without the key must fail...');
		await assertUnreadable(path, undefined, 'a keyed database must not be readable without the key');
		this.log(TAG, '  → unreadable ✓');

		this.log(TAG, 'Reopening with a wrong key must fail...');
		await assertUnreadable(path, 'the-wrong-key', 'a keyed database must not be readable with a wrong key');
		this.log(TAG, '  → unreadable ✓');

		// A raw key skips the per-connection PBKDF2 derivation; it is a different
		// key from the same characters as a passphrase, so it needs its own file.
		const rawPath = tempDb('test_cipher_raw.db');
		const rawKey = '0123456789abcdef'.repeat(4);
		this.log(TAG, 'Round-tripping a raw key...');
		const db3 = openDatabase({ path: rawPath, encryptionKey: rawKey, encryptionKeyFormat: 'raw' });
		try {
			await db3.execute(`CREATE TABLE secret (id INTEGER PRIMARY KEY, val TEXT)`);
			await db3.execute(`INSERT INTO secret VALUES (1, 'raw')`);
		} finally {
			await db3.close();
		}
		const db4 = openDatabase({ path: rawPath, encryptionKey: rawKey, encryptionKeyFormat: 'raw' });
		try {
			const row = await db4.get<{ val: string }>(`SELECT val FROM secret WHERE id = 1`);
			assertEqual(row!.val, 'raw', 'raw-key value survives close/reopen');
			this.log(TAG, `  → val='${row!.val}' ✓`);
		} finally {
			await db4.close();
		}
		await assertUnreadable(rawPath, rawKey, 'a raw key and the same characters as a passphrase are different keys');
		this.log(TAG, '  → passphrase form does not open the raw-keyed file ✓');

		console.log(TAG, 'PASSED');
	}

	// ── 24. What a keyed open costs the JS thread (needs a codec) ─────────────
	async testKeyedOpenLatency() {
		const TAG = '[KeyedOpen]';
		const key = 'latency-probe-key';

		const measure = async (label: string, options: DatabaseOptions): Promise<number> => {
			const t0 = Date.now();
			const db = openDatabase(options);
			const ms = Date.now() - t0;
			try {
				await db.initialized();
				await db.execute(`CREATE TABLE IF NOT EXISTS k (x INTEGER)`);
			} finally {
				await db.close();
			}
			this.log(TAG, `  → ${label}: ${ms}ms on the JS thread`);
			return ms;
		};

		const pool4 = await measure('keyed, poolSize 4', { path: tempDb('test_lat4.db'), encryptionKey: key, poolSize: 4 });
		const pool1 = await measure('keyed, poolSize 1', { path: tempDb('test_lat1.db'), encryptionKey: key, poolSize: 1 });
		const async4 = await measure('keyed, poolSize 4, asyncOpen', { path: tempDb('test_lata4.db'), encryptionKey: key, poolSize: 4, asyncOpen: true });
		console.log(TAG, `openDatabase on the JS thread: pool4=${pool4}ms pool1=${pool1}ms asyncOpen=${async4}ms`);

		// Only the writer is keyed on the JS thread now, so a larger pool must not
		// cost the JS thread more.
		assert(pool4 < pool1 * 2 + 100, `poolSize 4 (${pool4}ms) should not scale with the pool the way it used to (poolSize 1 was ${pool1}ms)`);
		assert(async4 < 50, `asyncOpen should keep every derivation off the JS thread, took ${async4}ms`);

		this.log(TAG, 'A wrong key still throws from openDatabase in the default mode...');
		const path = tempDb('test_wrongkey.db');
		const seed = openDatabase({ path, encryptionKey: key, poolSize: 1 });
		await seed.execute(`CREATE TABLE k (x INTEGER)`);
		await seed.close();

		let threw = false;
		try {
			openDatabase({ path, encryptionKey: 'not-the-key', poolSize: 1 });
		} catch (e) {
			threw = true;
			assertEqual((e as SQLiteError).code, SQLITE_NOTADB, 'wrong key reports SQLITE_NOTADB at open');
		}
		assert(threw, 'a wrong key should throw from openDatabase');

		this.log(TAG, 'With asyncOpen it surfaces through initialized() instead...');
		const bad = openDatabase({ path, encryptionKey: 'not-the-key', poolSize: 1, asyncOpen: true });
		let rejected = false;
		try {
			await bad.initialized();
		} catch (e) {
			rejected = true;
			assertEqual((e as SQLiteError).code, SQLITE_NOTADB, 'initialized() rejects with SQLITE_NOTADB');
		}
		assert(rejected, 'initialized() should reject after a failed async open');

		let syncThrew = false;
		try {
			bad.getSync(`SELECT 1`);
		} catch (e) {
			syncThrew = true;
			assertEqual((e as SQLiteError).code, SQLITE_NOTADB, 'sync methods report the open error');
		}
		assert(syncThrew, 'a sync method should throw the open error');

		let asyncRejected = false;
		try {
			await bad.execute(`SELECT 1`);
		} catch (e) {
			asyncRejected = true;
			assertEqual((e as SQLiteError).code, SQLITE_NOTADB, 'async methods reject with the open error');
		}
		assert(asyncRejected, 'an async method should reject with the open error');
		await bad.close();

		// A pooled read would land on a reader the pool never started; it has to
		// report why the database could not be opened, not that it is closed.
		this.log(TAG, 'A pooled read issued before a failing open settles...');
		const bad2 = openDatabase({ path, encryptionKey: 'not-the-key', poolSize: 2, asyncOpen: true });
		let readRejected = false;
		try {
			await bad2.select(`SELECT 1`);
		} catch (e) {
			readRejected = true;
			assertEqual((e as SQLiteError).code, SQLITE_NOTADB, 'a pooled read should report the open error');
		}
		assert(readRejected, 'a pooled read on a failed open should reject');
		await bad2.close();

		console.log(TAG, 'PASSED');
	}

	// ── 25. openSequence validation (no codec needed) ─────────────────────────
	async testOpenSequenceValidation() {
		const TAG = '[OpenSeqValidation]';

		const rejects = (msg: string, options: DatabaseOptions) => {
			let threw = false;
			let db: SQLiteDatabase | undefined;
			try {
				db = openDatabase(options);
			} catch (e) {
				threw = true;
				assert(e instanceof SQLiteError, `${msg}: should throw SQLiteError`);
				assertEqual((e as SQLiteError).code, SQLITE_MISUSE, `${msg}: should report SQLITE_MISUSE`);
				this.log(TAG, `  → ${(e as SQLiteError).message} ✓`);
			}
			if (db) db.close().catch(() => undefined);
			assert(threw, `${msg}: should have thrown`);
		};

		this.log(TAG, 'onOpen and openSequence together...');
		rejects('onOpen + openSequence', { path: tempDb('test_seq_both.db'), onOpen: ['PRAGMA user_version = 1'], openSequence: [OpenStep.key, OpenStep.wal] });

		this.log(TAG, 'A repeated marker...');
		rejects('duplicate key', { path: tempDb('test_seq_dupkey.db'), openSequence: [OpenStep.key, OpenStep.key, OpenStep.wal] });
		rejects('duplicate wal', { path: tempDb('test_seq_dupwal.db'), openSequence: [OpenStep.key, OpenStep.wal, OpenStep.wal] });

		this.log(TAG, 'A key with no key step must be refused, and must create no file...');
		const orphan = knownFolders.documents().path + '/test_seq_nokey.db';
		if (File.exists(orphan)) File.fromPath(orphan).remove();
		rejects('encryptionKey without OpenStep.key', { path: orphan, encryptionKey: 'some-key', openSequence: [OpenStep.wal] });
		assert(!File.exists(orphan), 'a refused sequence must not have created the database file');

		this.log(TAG, 'wal before key with a key set...');
		rejects('wal before key', { path: tempDb('test_seq_order.db'), encryptionKey: 'some-key', openSequence: [OpenStep.wal, OpenStep.key] });

		this.log(TAG, 'A malformed entry...');
		rejects('bad scope', { path: tempDb('test_seq_scope.db'), openSequence: [OpenStep.key, { sql: 'PRAGMA user_version = 1', on: 'nobody' as any }, OpenStep.wal] });

		console.log(TAG, 'PASSED');
	}

	// ── 26. openSequence behaviour (no codec needed) ──────────────────────────
	async testOpenSequence() {
		const TAG = '[OpenSequence]';

		this.log(TAG, 'The default sequence and its explicit spelling must agree...');
		const viaOnOpen = openDatabase({ path: tempDb('test_seq_a.db'), onOpen: ['PRAGMA user_version = 7'] });
		const viaSequence = openDatabase({ path: tempDb('test_seq_b.db'), openSequence: [OpenStep.key, 'PRAGMA user_version = 7', OpenStep.wal] });
		try {
			const a = viaOnOpen.getSync<{ user_version: number }>(`PRAGMA user_version`);
			const b = viaSequence.getSync<{ user_version: number }>(`PRAGMA user_version`);
			assertEqual(a!.user_version, 7, 'onOpen applied');
			assertEqual(b!.user_version, 7, 'openSequence applied');
			assertEqual(viaOnOpen.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)!.journal_mode, 'wal', 'onOpen still gets WAL');
			assertEqual(viaSequence.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)!.journal_mode, 'wal', 'explicit wal step');
		} finally {
			await viaOnOpen.close();
			await viaSequence.close();
		}

		this.log(TAG, 'Leaving out the wal step leaves the journal mode alone...');
		const noWal = openDatabase({ path: tempDb('test_seq_nowal.db'), openSequence: [OpenStep.key], serialized: true });
		try {
			await noWal.execute(`CREATE TABLE t (x INTEGER)`);
			assertEqual(noWal.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)!.journal_mode, 'delete', 'a new file keeps its rollback journal without a wal step');
		} finally {
			await noWal.close();
		}

		this.log(TAG, 'A writer-scoped page_size before wal takes effect on a new file...');
		const paged = openDatabase({ path: tempDb('test_seq_page.db'), openSequence: [OpenStep.key, { sql: 'PRAGMA page_size = 8192', on: 'writer' }, OpenStep.wal] });
		try {
			await paged.execute(`CREATE TABLE t (x INTEGER)`);
			assertEqual(paged.getSync<{ page_size: number }>(`PRAGMA page_size`)!.page_size, 8192, 'page_size applied before WAL');
			assertEqual(paged.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)!.journal_mode, 'wal', 'still WAL');
		} finally {
			await paged.close();
		}

		this.log(TAG, 'Scoping is observable from the pool...');
		const scoped = openDatabase({
			path: tempDb('test_seq_scoped.db'),
			poolSize: 2,
			serialized: false,
			openSequence: [OpenStep.key, { sql: 'PRAGMA cache_size = -1234', on: 'readers' }, { sql: 'PRAGMA cache_size = -4321', on: 'writer' }, OpenStep.wal],
		});
		try {
			// A sync read runs on the writer; an async read goes to a reader.
			assertEqual(scoped.getSync<{ cache_size: number }>(`PRAGMA cache_size`)!.cache_size, -4321, 'writer-scoped step applied to the writer');
			for (let i = 0; i < 4; i++) {
				const seen = await scoped.get<{ cache_size: number }>(`PRAGMA cache_size`);
				assertEqual(seen!.cache_size, -1234, `reader ${i} got the reader-scoped step`);
			}
		} finally {
			await scoped.close();
		}

		// A step is named by its index, not quoted back. SQLite's own diagnostic
		// still names the object it could not resolve, which is the half worth
		// keeping; what must not appear is the statement the caller wrote.
		this.log(TAG, 'A failing step reports its index, not the statement...');
		const failingSql = 'SELECT nosuchcolumn FROM sqlite_schema';
		let threw = false;
		try {
			openDatabase({ path: tempDb('test_seq_fail.db'), openSequence: [OpenStep.key, failingSql, OpenStep.wal] });
		} catch (e) {
			threw = true;
			const err = e as SQLiteError;
			assert(err instanceof SQLiteError, 'should throw SQLiteError');
			assert(typeof err.code === 'number' && err.code !== 0, 'should carry a SQLite code');
			assert(/open step 1 failed/.test(err.message), `message should name the step index, got: ${err.message}`);
			assert(err.message.indexOf(failingSql) === -1, `message must not repeat the statement, got: ${err.message}`);
			this.log(TAG, `  → ${err.message} ✓`);
		}
		assert(threw, 'a failing open step should abort the open');

		console.log(TAG, 'PASSED');
	}

	// ── 27. Writer-first ordering under asyncOpen ─────────────────────────────
	async testOpenSequenceWriterFirst() {
		const TAG = '[WriterFirst]';
		this.log(TAG, 'Fresh file + asyncOpen + pool, 30 times...');
		for (let i = 0; i < 30; i++) {
			const db = openDatabase({
				path: tempDb('test_seq_writerfirst.db'),
				asyncOpen: true,
				poolSize: 4,
				openSequence: [OpenStep.key, { sql: 'PRAGMA page_size = 8192', on: 'writer' }, OpenStep.wal],
			});
			try {
				await db.initialized();
				await db.execute(`CREATE TABLE t (x INTEGER)`);
				const page = db.getSync<{ page_size: number }>(`PRAGMA page_size`);
				const mode = db.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`);
				assertEqual(page!.page_size, 8192, `round ${i}: page_size must be set before any reader touched the file`);
				assertEqual(mode!.journal_mode, 'wal', `round ${i}: journal mode`);
				for (let r = 0; r < 4; r++) {
					const row = await db.get<{ n: number }>(`SELECT count(*) AS n FROM t`);
					assertEqual(row!.n, 0, `round ${i}: pooled read ${r}`);
				}
			} finally {
				await db.close();
			}
		}
		this.log(TAG, '  → 30/30 ✓');
		console.log(TAG, 'PASSED');
	}

	// ── 28. A step before the key (needs a codec) ─────────────────────────────
	async testOpenSequenceBeforeKey() {
		const TAG = '[OpenSeqBeforeKey]';
		const path = tempDb('test_seq_cipher.db');
		const key = 'sequence-cipher-key';
		// A non-default cipher has to be selected before the key is applied, so
		// this only works if the step really runs first.
		const sequence = [{ sql: "PRAGMA cipher = 'chacha20'" }, OpenStep.key, OpenStep.wal];

		this.log(TAG, 'Creating with a cipher selected before the key...');
		const db = openDatabase({ path, encryptionKey: key, openSequence: sequence, serialized: true });
		try {
			await db.execute(`CREATE TABLE secret (id INTEGER PRIMARY KEY, val TEXT)`);
			await db.execute(`INSERT INTO secret VALUES (1, 'hidden')`);
		} finally {
			await db.close();
		}

		this.log(TAG, 'The default sequence with the same key must NOT open it...');
		await assertUnreadable(path, key, 'a database created under a non-default cipher must not open with the default sequence');

		this.log(TAG, 'The same sequence and key must open it...');
		const again = openDatabase({ path, encryptionKey: key, openSequence: sequence, serialized: true });
		try {
			const row = await again.get<{ val: string }>(`SELECT val FROM secret WHERE id = 1`);
			assertEqual(row!.val, 'hidden', 'reopened under the same sequence');
		} finally {
			await again.close();
		}

		this.log(TAG, 'A failing key step must not put the key in the message...');
		let threw = false;
		try {
			openDatabase({ path, encryptionKey: 'the-wrong-key-entirely', openSequence: sequence, serialized: true });
		} catch (e) {
			threw = true;
			const message = (e as SQLiteError).message;
			assert(message.indexOf('the-wrong-key-entirely') === -1, `the key must never appear in an error, got: ${message}`);
			this.log(TAG, `  → ${message} ✓`);
		}
		assert(threw, 'a wrong key should still fail the open');

		console.log(TAG, 'PASSED');
	}

	// ── Benchmarks ──────────────────────────────────────────────────────────────

	async benchmarkAll() {
		await runBenchmarks();
	}

	async benchmarkQuick() {
		await runBenchmarks({ quick: true });
	}
}
