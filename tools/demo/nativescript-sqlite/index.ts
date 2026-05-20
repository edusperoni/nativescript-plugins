import { knownFolders, File } from '@nativescript/core';
import { DemoSharedBase } from '../utils';
import { openDatabase, SQLiteDatabase, SQLiteError, SQLITE_CONSTRAINT, SQLITE_ERROR } from '@edusperoni/nativescript-sqlite';

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

			this.log(TAG, 'getArraySync: id=1...');
			const singleArr = db.getArraySync(`SELECT id, v FROM sync_t WHERE id = ?`, [1]);
			assertEqual(singleArr.rows.length, 1, 'getArraySync row');
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
			await this.testSQLCipher();
			console.log('[ALL] All tests PASSED');
		} finally {
			this.verbose = prev;
		}
	}

	// ── 12. SQLCipher (Android optional dep) ──────────────────────────────────
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
			console.log(TAG, 'PASSED');
		} finally {
			await db2.close();
		}
	}

	// ── Benchmarks ────────────────────────────────────────────────────────────

	async benchmarkBulkInsert() {
		const TAG = '[Bench:BulkInsert]';
		const N = 2000;

		// Use a unique name so concurrent invocations don't share or corrupt the same file.
		const db1Path = tempDb(`bench_insert_${Date.now().toString(36)}.db`);
		// 1. Autocommit
		const db1 = openDatabase({ path: db1Path });
		try {
			await db1.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
			const t0 = Date.now();
			for (let i = 0; i < N; i++) {
				await db1.execute(`INSERT INTO t VALUES (?, ?)`, [i, `val${i}`]);
			}
			const autocommitMs = Date.now() - t0;

			// 2. Transaction
			await db1.execute(`DELETE FROM t`);
			const t1 = Date.now();
			await db1.transaction(async (tx) => {
				for (let i = 0; i < N; i++) {
					await tx.execute(`INSERT INTO t VALUES (?, ?)`, [i, `val${i}`]);
				}
			});
			const txMs = Date.now() - t1;

			// 3. Prepared statement in transaction
			await db1.execute(`DELETE FROM t`);
			const t2 = Date.now();
			const stmt = await db1.prepare(`INSERT INTO t VALUES (?, ?)`);
			await db1.transaction(async (_tx) => {
				for (let i = 0; i < N; i++) {
					await stmt.execute([i, `val${i}`]);
				}
			});
			await stmt.finalize();
			const preparedMs = Date.now() - t2;

			console.log(TAG, `N=${N} | autocommit=${autocommitMs}ms | tx=${txMs}ms | prepared+tx=${preparedMs}ms`);
		} finally {
			await db1.close();
			try {
				File.fromPath(db1Path).remove();
			} catch (_) {}
		}
	}

	async benchmarkBulkSelect() {
		const TAG = '[Bench:BulkSelect]';
		const N = 2000;
		const dbPath = tempDb(`bench_select_${Date.now().toString(36)}.db`);
		const db = openDatabase({ path: dbPath });
		try {
			await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b REAL, c INTEGER)`);
			await db.transaction(async (tx) => {
				const stmt = await db.prepare(`INSERT INTO t VALUES (?, ?, ?, ?)`);
				for (let i = 0; i < N; i++) {
					await stmt.execute([i, `str${i}`, i * 1.5, i % 100]);
				}
				await stmt.finalize();
			});

			// 1. select (object rows)
			const t0 = Date.now();
			await db.select(`SELECT * FROM t`);
			const objectMs = Date.now() - t0;

			// 2. selectArray (array rows)
			const t1 = Date.now();
			await db.selectArray(`SELECT * FROM t`);
			const arrayMs = Date.now() - t1;

			// 3. selectSync (sync object rows)
			const t2 = Date.now();
			db.selectSync(`SELECT * FROM t`);
			const syncMs = Date.now() - t2;

			console.log(TAG, `N=${N} | object=${objectMs}ms | array=${arrayMs}ms | sync=${syncMs}ms`);
		} finally {
			await db.close();
			try {
				File.fromPath(dbPath).remove();
			} catch (_) {}
		}
	}

	async benchmarkConcurrentReads() {
		const TAG = '[Bench:ConcurrentReads]';
		const N = 50;
		const POOL = 4;
		const path = tempDb(`bench_concurrent_${Date.now().toString(36)}.db`);

		// Seed data
		const seed = openDatabase({ path });
		try {
			await seed.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
			await seed.transaction(async (tx) => {
				for (let i = 0; i < 500; i++) await tx.execute(`INSERT INTO t VALUES (?, ?)`, [i, `v${i}`]);
			});
		} finally {
			await seed.close();
		}

		// Sequential (pool=1)
		const dbSeq = openDatabase({ path, readOnly: true });
		try {
			const t0 = Date.now();
			for (let i = 0; i < N; i++) {
				await dbSeq.select(`SELECT * FROM t WHERE id < 100`);
			}
			const seqMs = Date.now() - t0;

			// Concurrent (poolSize > 1)
			const dbPool = openDatabase({ path, readOnly: true, poolSize: POOL });
			try {
				const t1 = Date.now();
				await Promise.all(Array.from({ length: N }, () => dbPool.select(`SELECT * FROM t WHERE id < 100`)));
				const poolMs = Date.now() - t1;
				console.log(TAG, `N=${N} queries | sequential=${seqMs}ms | pool(${POOL})=${poolMs}ms`);
			} finally {
				await dbPool.close();
			}
		} finally {
			await dbSeq.close();
			try {
				File.fromPath(path).remove();
			} catch (_) {}
		}
	}

	async benchmarkPreparedVsDirect() {
		const TAG = '[Bench:PreparedVsDirect]';
		const N = 500;
		const dbPath = tempDb(`bench_prep_${Date.now().toString(36)}.db`);
		const db = openDatabase({ path: dbPath });
		try {
			await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
			await db.transaction(async (tx) => {
				for (let i = 0; i < N; i++) await tx.execute(`INSERT INTO t VALUES (?, ?)`, [i, `v${i}`]);
			});

			// Direct query
			const t0 = Date.now();
			for (let i = 0; i < N; i++) {
				await db.get(`SELECT v FROM t WHERE id = ?`, [i]);
			}
			const directMs = Date.now() - t0;

			// Prepared query
			const stmt = await db.prepare(`SELECT v FROM t WHERE id = ?`);
			const t1 = Date.now();
			for (let i = 0; i < N; i++) {
				await stmt.get([i]);
			}
			await stmt.finalize();
			const preparedMs = Date.now() - t1;

			console.log(TAG, `N=${N} | direct=${directMs}ms | prepared=${preparedMs}ms`);
		} finally {
			await db.close();
			try {
				File.fromPath(dbPath).remove();
			} catch (_) {}
		}
	}

	async benchmarkAll() {
		console.log('[Bench] Starting all benchmarks...');
		await this.benchmarkBulkInsert();
		await this.benchmarkBulkSelect();
		await this.benchmarkConcurrentReads();
		await this.benchmarkPreparedVsDirect();
		console.log('[Bench] All benchmarks complete');
	}
}
