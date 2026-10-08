import { File, knownFolders } from '@nativescript/core';
import { openDatabase, PreparedStatement, SQLiteDatabase } from '@edusperoni/nativescript-sqlite';
import { BenchCase } from './harness';

// Sample budgets are fixed per case: CHEAP for cases whose single sample stays well under ~300ms,
// HEAVY for the bulk/IO cases above it. `quick` collapses both to a smoke-test budget.
const CHEAP = { warmup: 3, samples: 15 };
const HEAVY = { warmup: 1, samples: 7 };
const QUICK = { warmup: 1, samples: 2 };

export const CONCURRENCY_POOL_SIZE = 4;

function tempPath(name: string): string {
	return knownFolders.temp().path + '/' + name;
}

function removeDbFiles(path: string) {
	const suffixes = ['', '-wal', '-shm', '-journal'];
	for (let i = 0; i < suffixes.length; i++) {
		try {
			const candidate = path + suffixes[i];
			if (File.exists(candidate)) File.fromPath(candidate).remove();
		} catch (err) {
			/* best effort */
		}
	}
}

function freshDb(fileName: string): { db: SQLiteDatabase; path: string } {
	const path = tempPath(fileName);
	removeDbFiles(path);
	return { db: openDatabase({ path }), path };
}

function makeText(length: number, seed: number): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
	let out = '';
	while (out.length < length) out += alphabet.charAt((out.length + seed) % alphabet.length);
	return out.substring(0, length);
}

function makeUnicodeText(length: number): string {
	const chunk = 'Lorem ipsum dolor sit amet — ünïcödé 漢字テスト Ω≈ç√ ✓ ';
	let out = '';
	while (out.length < length) out += chunk;
	return out.substring(0, length);
}

function makeBlob(bytes: number): ArrayBuffer {
	const view = new Uint8Array(bytes);
	for (let i = 0; i < bytes; i++) view[i] = i & 0xff;
	return view.buffer as ArrayBuffer;
}

const MARSHAL_SQL = 'SELECT id, r, s, t, n, nt FROM m';

function expectRows(caseName: string, actual: number, expected: number) {
	if (actual !== expected) throw new Error(caseName + ' returned ' + actual + ' rows, expected ' + expected);
}

// Runs untimed after each sample: a write path that silently drops work must fail, not look fast.
function expectCountAndClear(caseName: string, db: SQLiteDatabase, table: string, expected: number) {
	const row = db.getSync<{ c: number }>('SELECT count(*) AS c FROM ' + table);
	expectRows(caseName, row ? row.c : -1, expected);
	db.executeSync('DELETE FROM ' + table);
}

function seedMarshalTable(db: SQLiteDatabase, rows: number) {
	db.executeSync('CREATE TABLE m (id INTEGER PRIMARY KEY, r REAL, s TEXT, t TEXT, n INTEGER, nt TEXT)');
	const long = makeText(200, 7);
	db.executeSync('BEGIN');
	for (let i = 0; i < rows; i++) {
		db.executeSync('INSERT INTO m VALUES (?, ?, ?, ?, ?, ?)', [i, i * 1.25, 's' + i, long, i % 1000, i % 4 === 0 ? null : 'x' + i]);
	}
	db.executeSync('COMMIT');
}

function seedKeyedTable(db: SQLiteDatabase, rows: number) {
	db.executeSync('CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT, r REAL)');
	db.executeSync('BEGIN');
	for (let i = 0; i < rows; i++) {
		db.executeSync('INSERT INTO k VALUES (?, ?, ?)', [i, 'v' + i, i * 0.5]);
	}
	db.executeSync('COMMIT');
}

export function buildCases(quick: boolean): BenchCase[] {
	const size = (n: number) => (quick ? Math.max(1, Math.round(n / 10)) : n);
	const cheap = () => (quick ? QUICK : CHEAP);
	const heavy = () => (quick ? QUICK : HEAVY);
	const cases: BenchCase[] = [];

	// ── control ───────────────────────────────────────────────────────────────
	{
		const rowCount = size(10000);
		let json = '';
		cases.push({
			name: 'control/json-parse',
			group: 'control',
			opsPerSample: 1,
			...cheap(),
			setup() {
				const rows: unknown[] = [];
				for (let i = 0; i < rowCount; i++) {
					rows.push({ id: i, name: 'row-' + i, value: i * 1.5, label: makeText(40, i % 37), flag: i % 2 === 0, note: null });
				}
				json = JSON.stringify(rows);
			},
			fn() {
				const parsed = JSON.parse(json);
				if (parsed.length !== rowCount) throw new Error('control/json-parse produced ' + parsed.length + ' rows');
			},
		});
	}

	{
		const rowCount = size(10000);
		cases.push({
			name: 'control/object-alloc',
			group: 'control',
			opsPerSample: rowCount,
			...cheap(),
			fn() {
				const out = new Array(rowCount);
				let sum = 0;
				for (let i = 0; i < rowCount; i++) {
					const row = { id: i, ratio: i * 0.5, label: 'v' + i, flag: i % 3 === 0, note: i % 7 === 0 ? null : 'n' + i, ts: 1700000000000 + i };
					out[i] = row;
					sum += row.ratio;
				}
				if (sum < 0) throw new Error('control/object-alloc sum underflow');
			},
		});
	}

	// ── call overhead ─────────────────────────────────────────────────────────
	const syncCalls: { name: string; run: (db: SQLiteDatabase, i: number) => void }[] = [
		{ name: 'sync/getSync-select1', run: (db) => void db.getSync('SELECT 1 AS x') },
		{ name: 'sync/getSync-1param', run: (db, i) => void db.getSync('SELECT ? AS x', [i]) },
		{ name: 'sync/executeSync-noop', run: (db) => db.executeSync('SELECT 1') },
	];
	syncCalls.forEach((spec, index) => {
		const iterations = size(10000);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: spec.name,
			group: 'call-overhead',
			opsPerSample: iterations,
			...cheap(),
			setup() {
				const created = freshDb('nscbench_call_' + index + '.db');
				db = created.db;
				path = created.path;
			},
			fn() {
				for (let i = 0; i < iterations; i++) spec.run(db, i);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	});

	const asyncCalls: { name: string; run: (db: SQLiteDatabase, iterations: number) => Promise<void> }[] = [
		{
			name: 'async/get-select1-serial',
			run: async (db, iterations) => {
				for (let i = 0; i < iterations; i++) await db.get('SELECT 1 AS x');
			},
		},
		{
			name: 'async/get-select1-burst',
			run: async (db, iterations) => {
				const pending: Promise<unknown>[] = [];
				for (let i = 0; i < iterations; i++) pending.push(db.get('SELECT 1 AS x'));
				await Promise.all(pending);
			},
		},
	];
	asyncCalls.forEach((spec, index) => {
		const iterations = size(2000);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: spec.name,
			group: 'call-overhead',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_async_' + index + '.db');
				db = created.db;
				path = created.path;
			},
			fn() {
				return spec.run(db, iterations);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	});

	// ── params ────────────────────────────────────────────────────────────────
	const PARAMS_DDL = 'CREATE TABLE p8 (i INTEGER, r REAL, t1 TEXT, t2 TEXT, t3 TEXT, b BLOB, n TEXT, f INTEGER)';
	const paramBlob = makeBlob(64);
	const paramShort = makeText(8, 1);
	const paramMedium = makeText(64, 2);
	const paramLong = makeText(256, 3);

	{
		const iterations = size(5000);
		const sql = 'INSERT INTO p8 (i, r, t1, t2, t3, b, n, f) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
		let db: SQLiteDatabase;
		cases.push({
			name: 'params/positional-8',
			group: 'params',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				db = openDatabase({ path: ':memory:' });
				db.executeSync(PARAMS_DDL);
			},
			fn() {
				db.executeSync('BEGIN');
				for (let i = 0; i < iterations; i++) {
					db.executeSync(sql, [i, i * 1.5, paramShort, paramMedium, paramLong, paramBlob, null, i % 2 === 0]);
				}
				db.executeSync('COMMIT');
			},
			afterEach() {
				expectCountAndClear('params/positional-8', db, 'p8', iterations);
			},
			async teardown() {
				await db.close();
			},
		});
	}

	{
		const iterations = size(5000);
		const sql = 'INSERT INTO p8 (i, r, t1, t2, t3, b, n, f) VALUES (:i, :r, :t1, :t2, :t3, :b, :n, :f)';
		let db: SQLiteDatabase;
		cases.push({
			name: 'params/named-8',
			group: 'params',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				db = openDatabase({ path: ':memory:' });
				db.executeSync(PARAMS_DDL);
			},
			fn() {
				db.executeSync('BEGIN');
				for (let i = 0; i < iterations; i++) {
					db.executeSync(sql, { ':i': i, ':r': i * 1.5, ':t1': paramShort, ':t2': paramMedium, ':t3': paramLong, ':b': paramBlob, ':n': null, ':f': i % 2 === 0 });
				}
				db.executeSync('COMMIT');
			},
			afterEach() {
				expectCountAndClear('params/named-8', db, 'p8', iterations);
			},
			async teardown() {
				await db.close();
			},
		});
	}

	// ── marshal ───────────────────────────────────────────────────────────────
	const marshalRows = size(10000);
	const marshalReads: { name: string; run: (db: SQLiteDatabase) => number | Promise<number> }[] = [
		{ name: 'marshal/selectSync-objects', run: (db) => db.selectSync(MARSHAL_SQL).length },
		{ name: 'marshal/selectArraySync', run: (db) => db.selectArraySync(MARSHAL_SQL).rows.length },
		{ name: 'marshal/select-objects-async', run: (db) => db.select(MARSHAL_SQL).then((rows) => rows.length) },
		{ name: 'marshal/selectArray-async', run: (db) => db.selectArray(MARSHAL_SQL).then((result) => result.rows.length) },
	];
	marshalReads.forEach((spec, index) => {
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: spec.name,
			group: 'marshal',
			opsPerSample: 1,
			...cheap(),
			setup() {
				const created = freshDb('nscbench_marshal_' + index + '.db');
				db = created.db;
				path = created.path;
				seedMarshalTable(db, marshalRows);
			},
			async fn() {
				expectRows(spec.name, await spec.run(db), marshalRows);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	});

	{
		const iterations = size(2000);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'marshal/select-1row-x2000',
			group: 'marshal',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_marshal_pk.db');
				db = created.db;
				path = created.path;
				seedMarshalTable(db, marshalRows);
			},
			fn() {
				for (let i = 0; i < iterations; i++) db.getSync('SELECT id, r, s, t, n, nt FROM m WHERE id = ?', [i % marshalRows]);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	{
		const rows = size(500);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'marshal/wide-text',
			group: 'marshal',
			opsPerSample: 1,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_wide_text.db');
				db = created.db;
				path = created.path;
				const wide = makeUnicodeText(16 * 1024);
				db.executeSync('CREATE TABLE w (id INTEGER PRIMARY KEY, body TEXT)');
				db.executeSync('BEGIN');
				for (let i = 0; i < rows; i++) db.executeSync('INSERT INTO w VALUES (?, ?)', [i, wide]);
				db.executeSync('COMMIT');
			},
			fn() {
				expectRows('marshal/wide-text', db.selectSync('SELECT id, body FROM w').length, rows);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	// ── blob ──────────────────────────────────────────────────────────────────
	{
		const iterations = size(8);
		const payload = makeBlob(1024 * 1024);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'blob/write-1MBx8',
			group: 'blob',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_blob_write.db');
				db = created.db;
				path = created.path;
				db.executeSync('CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)');
			},
			fn() {
				db.executeSync('BEGIN');
				for (let i = 0; i < iterations; i++) db.executeSync('INSERT INTO b VALUES (?, ?)', [i, payload]);
				db.executeSync('COMMIT');
			},
			afterEach() {
				expectCountAndClear('blob/write-1MBx8', db, 'b', iterations);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	const blobReads: { name: string; rows: number; bytes: number; file: string }[] = [
		{ name: 'blob/read-1MBx8', rows: size(8), bytes: 1024 * 1024, file: 'nscbench_blob_read_big.db' },
		{ name: 'blob/read-1KBx5000', rows: size(5000), bytes: 1024, file: 'nscbench_blob_read_small.db' },
	];
	blobReads.forEach((spec) => {
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: spec.name,
			group: 'blob',
			opsPerSample: 1,
			...heavy(),
			setup() {
				const created = freshDb(spec.file);
				db = created.db;
				path = created.path;
				const payload = makeBlob(spec.bytes);
				db.executeSync('CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)');
				db.executeSync('BEGIN');
				for (let i = 0; i < spec.rows; i++) db.executeSync('INSERT INTO b VALUES (?, ?)', [i, payload]);
				db.executeSync('COMMIT');
			},
			fn() {
				expectRows(spec.name, db.selectSync('SELECT id, data FROM b').length, spec.rows);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	});

	// ── prepared ──────────────────────────────────────────────────────────────
	{
		const iterations = size(5000);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'prepared/insert-tx-5000',
			group: 'prepared',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_prepared_insert.db');
				db = created.db;
				path = created.path;
				db.executeSync('CREATE TABLE p (id INTEGER, v TEXT, r REAL)');
			},
			async fn() {
				const stmt = await db.prepare('INSERT INTO p VALUES (?, ?, ?)');
				await db.transaction(async () => {
					for (let i = 0; i < iterations; i++) await stmt.execute([i, 'v' + i, i * 0.25]);
				});
				await stmt.finalize();
			},
			afterEach() {
				expectCountAndClear('prepared/insert-tx-5000', db, 'p', iterations);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	{
		const iterations = size(2000);
		let db: SQLiteDatabase;
		let stmt: PreparedStatement;
		let path = '';
		cases.push({
			name: 'prepared/get-by-pk-2000',
			group: 'prepared',
			opsPerSample: iterations,
			...heavy(),
			async setup() {
				const created = freshDb('nscbench_prepared_get.db');
				db = created.db;
				path = created.path;
				seedKeyedTable(db, iterations);
				stmt = await db.prepare('SELECT v, r FROM k WHERE id = ?');
			},
			async fn() {
				for (let i = 0; i < iterations; i++) await stmt.get([i]);
			},
			async teardown() {
				await stmt.finalize();
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	{
		const iterations = size(2000);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'direct/get-by-pk-2000',
			group: 'prepared',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_direct_get.db');
				db = created.db;
				path = created.path;
				seedKeyedTable(db, iterations);
			},
			async fn() {
				for (let i = 0; i < iterations; i++) await db.get('SELECT v, r FROM k WHERE id = ?', [i]);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	// ── tx ────────────────────────────────────────────────────────────────────
	{
		const iterations = size(5000);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'tx/insert-async-5000',
			group: 'tx',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_tx_insert.db');
				db = created.db;
				path = created.path;
				db.executeSync('CREATE TABLE t (id INTEGER, v TEXT)');
			},
			async fn() {
				await db.transaction(async (tx) => {
					for (let i = 0; i < iterations; i++) await tx.execute('INSERT INTO t VALUES (?, ?)', [i, 'v' + i]);
				});
			},
			afterEach() {
				expectCountAndClear('tx/insert-async-5000', db, 't', iterations);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	{
		const iterations = size(500);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: 'tx/autocommit-insert-500',
			group: 'tx',
			opsPerSample: iterations,
			...heavy(),
			setup() {
				const created = freshDb('nscbench_tx_autocommit.db');
				db = created.db;
				path = created.path;
				db.executeSync('CREATE TABLE t (id INTEGER, v TEXT)');
			},
			async fn() {
				for (let i = 0; i < iterations; i++) await db.execute('INSERT INTO t VALUES (?, ?)', [i, 'v' + i]);
			},
			afterEach() {
				expectCountAndClear('tx/autocommit-insert-500', db, 't', iterations);
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	}

	// ── concurrency ───────────────────────────────────────────────────────────
	const concurrencyReads: { name: string; poolSize: number; parallel: boolean; file: string }[] = [
		{ name: 'concurrency/reads-serial-200', poolSize: 1, parallel: false, file: 'nscbench_conc_serial.db' },
		{ name: 'concurrency/reads-pool4-200', poolSize: CONCURRENCY_POOL_SIZE, parallel: true, file: 'nscbench_conc_pool.db' },
	];
	concurrencyReads.forEach((spec) => {
		const iterations = size(200);
		const seedRows = size(500);
		let db: SQLiteDatabase;
		let path = '';
		cases.push({
			name: spec.name,
			group: 'concurrency',
			opsPerSample: iterations,
			...heavy(),
			async setup() {
				const created = freshDb(spec.file);
				path = created.path;
				try {
					seedKeyedTable(created.db, seedRows);
				} finally {
					await created.db.close();
				}
				db = openDatabase({ path, readOnly: true, poolSize: spec.poolSize });
			},
			async fn() {
				if (spec.parallel) {
					const pending: Promise<unknown>[] = [];
					for (let i = 0; i < iterations; i++) pending.push(db.select('SELECT id, v, r FROM k WHERE id < 100'));
					await Promise.all(pending);
				} else {
					for (let i = 0; i < iterations; i++) await db.select('SELECT id, v, r FROM k WHERE id < 100');
				}
			},
			async teardown() {
				await db.close();
				removeDbFiles(path);
			},
		});
	});

	// ── lifecycle ─────────────────────────────────────────────────────────────
	{
		const iterations = size(50);
		let path = '';
		cases.push({
			name: 'lifecycle/open-close',
			group: 'lifecycle',
			opsPerSample: iterations,
			...heavy(),
			async setup() {
				const created = freshDb('nscbench_lifecycle.db');
				path = created.path;
				created.db.executeSync('CREATE TABLE l (id INTEGER PRIMARY KEY)');
				await created.db.close();
			},
			async fn() {
				for (let i = 0; i < iterations; i++) {
					const db = openDatabase({ path });
					db.getSync('SELECT 1');
					await db.close();
				}
			},
			teardown() {
				removeDbFiles(path);
			},
		});
	}

	return cases;
}
