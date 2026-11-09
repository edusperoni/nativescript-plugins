import { openDatabase, SQLiteDatabase, SQLiteError, SQLITE_CONSTRAINT } from '@edusperoni/nativescript-sqlite';
import { closeQuietly, removeDbFiles, tempDbPath } from './helpers';

/** Hex of an ArrayBuffer's bytes; anything else is stringified so a non-buffer never matches. */
function hex(b: unknown): string {
	return b instanceof ArrayBuffer ? Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('') : String(b);
}

/**
 * Calls `fn` so that a synchronous throw surfaces as a rejection. The API does
 * not pin whether a bad argument or a closed database throws or rejects, and the
 * behavior under test is only that the call fails.
 */
function attempt(fn: () => unknown): Promise<unknown> {
	return new Promise((resolve) => resolve(fn()));
}

/** The reason `promise` rejects with, or undefined when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(e: unknown) => e,
	);
}

// Bind values that reach the binder untyped (any/unknown, column mappers), which the type system cannot reject.
const untyped = (v: unknown) => v as any;

describe('nativescript-sqlite: basics', () => {
	const opened: { db: SQLiteDatabase; path?: string }[] = [];

	function open(name: string): SQLiteDatabase {
		const path = tempDbPath(`spec_basics_${name}.db`);
		const db = openDatabase({ path });
		opened.push({ db, path });
		return db;
	}

	function openInMemory(): SQLiteDatabase {
		const db = openDatabase({ path: ':memory:' });
		opened.push({ db });
		return db;
	}

	afterEach(async () => {
		for (const { db, path } of opened.splice(0)) {
			await closeQuietly(db);
			if (path) removeDbFiles(path);
		}
	});

	describe('CRUD', () => {
		let db: SQLiteDatabase;

		beforeEach(async () => {
			db = open('crud');
			await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT NOT NULL)`);
			await db.execute(`INSERT INTO t (val) VALUES (?)`, ['alpha']);
			await db.execute(`INSERT INTO t (val) VALUES (?)`, ['beta']);
			await db.execute(`INSERT INTO t (val) VALUES (?)`, ['gamma']);
		});

		it('selects every inserted row in insertion order', async () => {
			const rows = await db.select<{ id: number; val: string }>(`SELECT * FROM t ORDER BY id`);
			expect(rows.length).toBe(3);
			expect(rows[0].val).toBe('alpha');
			expect(rows[2].val).toBe('gamma');
		});

		it('get returns the matching row', async () => {
			const row = await db.get<{ id: number; val: string }>(`SELECT * FROM t WHERE val = ?`, ['beta']);
			expect(row).toBeDefined();
			expect(row?.val).toBe('beta');
		});

		it('updates a row', async () => {
			const row = await db.get<{ id: number; val: string }>(`SELECT * FROM t WHERE val = ?`, ['beta']);
			expect(row).toBeDefined();
			await db.execute(`UPDATE t SET val = ? WHERE val = ?`, ['BETA', 'beta']);
			const updated = await db.get<{ val: string }>(`SELECT val FROM t WHERE id = ?`, [row?.id]);
			expect(updated?.val).toBe('BETA');
		});

		it('deletes a row', async () => {
			await db.execute(`DELETE FROM t WHERE val = ?`, ['beta']);
			const after = await db.select(`SELECT * FROM t`);
			expect(after.length).toBe(2);
		});

		it('get returns undefined when no row matches', async () => {
			const missing = await db.get(`SELECT * FROM t WHERE id = 9999`);
			expect(missing).toBeUndefined();
		});
	});

	describe('data types', () => {
		let db: SQLiteDatabase;

		beforeEach(() => {
			db = open('types');
		});

		it('round-trips INTEGER, REAL, TEXT, BLOB and NULL', async () => {
			await db.execute(`CREATE TABLE types (
id     INTEGER PRIMARY KEY,
i      INTEGER,
r      REAL,
t      TEXT,
b      BLOB,
n      INTEGER
)`);
			const blob = new Uint8Array([0x00, 0xff, 0x42, 0xab]).buffer as ArrayBuffer;
			await db.execute(`INSERT INTO types (i, r, t, b, n) VALUES (?, ?, ?, ?, ?)`, [42, 3.14, 'hello', blob, null]);

			const row = await db.get<{ i: number; r: number; t: string; b: ArrayBuffer; n: null }>(`SELECT i, r, t, b, n FROM types WHERE id = 1`);
			expect(row).toBeDefined();
			expect(row?.i).toBe(42);
			expect(row?.r).toBeCloseTo(3.14, 4);
			expect(row?.t).toBe('hello');
			expect(row?.n).toBeNull();
			expect(row?.b).toEqual(jasmine.any(ArrayBuffer));
			expect(Array.from(new Uint8Array(row?.b as ArrayBuffer))).toEqual([0x00, 0xff, 0x42, 0xab]);
		});

		it('binds true as 1 and false as 0', async () => {
			await db.execute(`CREATE TABLE bools (v INTEGER)`);
			await db.execute(`INSERT INTO bools (v) VALUES (?)`, [true]);
			await db.execute(`INSERT INTO bools (v) VALUES (?)`, [false]);
			const bools = await db.select<{ v: number }>(`SELECT v FROM bools ORDER BY rowid`);
			expect(bools[0].v).toBe(1);
			expect(bools[1].v).toBe(0);
		});
	});

	describe('parameter binding', () => {
		let db: SQLiteDatabase;

		beforeEach(async () => {
			db = open('params');
			await db.execute(`CREATE TABLE p (a TEXT, b INTEGER)`);
		});

		const rows = () => db.select<{ a: string; b: number }>(`SELECT a, b FROM p ORDER BY b`);

		it('binds positional ? parameters', async () => {
			await db.execute(`INSERT INTO p (a, b) VALUES (?, ?)`, ['pos', 1]);
			expect(await rows()).toEqual([{ a: 'pos', b: 1 }]);
		});

		it('binds :name parameters', async () => {
			await db.execute(`INSERT INTO p (a, b) VALUES (:a, :b)`, { ':a': 'named_colon', ':b': 2 });
			expect(await rows()).toEqual([{ a: 'named_colon', b: 2 }]);
		});

		it('binds $name parameters', async () => {
			await db.execute(`INSERT INTO p (a, b) VALUES ($a, $b)`, { $a: 'named_dollar', $b: 3 });
			expect(await rows()).toEqual([{ a: 'named_dollar', b: 3 }]);
		});

		it('binds @name parameters', async () => {
			await db.execute(`INSERT INTO p (a, b) VALUES (@a, @b)`, { '@a': 'named_at', '@b': 4 });
			expect(await rows()).toEqual([{ a: 'named_at', b: 4 }]);
		});

		it('binds a named parameter in a SELECT', async () => {
			await db.execute(`INSERT INTO p (a, b) VALUES ('pos', 1), ('named_colon', 2)`);
			const r = await db.get<{ b: number }>(`SELECT b FROM p WHERE a = :a`, { ':a': 'named_colon' });
			expect(r?.b).toBe(2);
		});
	});

	describe('buffer and view parameters', () => {
		let db: SQLiteDatabase;
		let backing: ArrayBuffer;

		const read = async (id: number) => (await db.get<{ b: ArrayBuffer | null }>(`SELECT b FROM blobs WHERE id = ?`, [id]))?.b;
		const count = async () => (await db.get<{ n: number }>(`SELECT count(*) AS n FROM blobs`))?.n;

		beforeEach(async () => {
			db = open('blob_params');
			await db.execute(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB)`);
			backing = new Uint8Array([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]).buffer;
		});

		it('binds a Uint8Array with a byteOffset as its own bytes', async () => {
			await db.execute(`INSERT INTO blobs VALUES (?, ?)`, [1, new Uint8Array(backing, 2, 3)]);
			expect(hex(await read(1))).toBe('121314');
		});

		it('binds a DataView with a byteOffset as a named parameter', async () => {
			await db.execute(`INSERT INTO blobs VALUES (:id, :b)`, { id: 2, b: new DataView(backing, 5, 2) });
			expect(hex(await read(2))).toBe('1516');
		});

		it('binds a multi-byte element view (Int16Array) with a byteOffset', async () => {
			await db.execute(`INSERT INTO blobs VALUES (?, ?)`, [3, new Int16Array(backing, 2, 2)]);
			expect(hex(await read(3))).toBe('12131415');
		});

		it('binds a SharedArrayBuffer', async () => {
			const shared = new SharedArrayBuffer(4);
			new Uint8Array(shared).set([0xa0, 0xa1, 0xa2, 0xa3]);
			await db.execute(`INSERT INTO blobs VALUES (?, ?)`, [4, shared]);
			expect(hex(await read(4))).toBe('a0a1a2a3');
		});

		it('binds a view over a SharedArrayBuffer', async () => {
			const shared = new SharedArrayBuffer(4);
			new Uint8Array(shared).set([0xa0, 0xa1, 0xa2, 0xa3]);
			await db.execute(`INSERT INTO blobs VALUES (?, ?)`, [5, new Uint8Array(shared, 1, 2)]);
			expect(hex(await read(5))).toBe('a1a2');
		});

		it('binds a view through executeSync', async () => {
			db.executeSync(`INSERT INTO blobs VALUES (?, ?)`, [6, new Uint8Array(backing, 6, 2)]);
			expect(hex(await read(6))).toBe('1617');
		});

		it('matches a view parameter in selectSync', async () => {
			await db.execute(`INSERT INTO blobs VALUES (?, ?)`, [1, new Uint8Array(backing, 2, 3)]);
			const found = db.selectSync<{ id: number }>(`SELECT id FROM blobs WHERE b = ?`, [new Uint8Array(backing, 2, 3)]);
			expect(found).toEqual([{ id: 1 }]);
		});

		it('binds a view through a prepared statement', async () => {
			const stmt = await db.prepare(`INSERT INTO blobs VALUES (?, ?)`);
			try {
				await stmt.execute([7, new Uint8Array(backing, 1, 1)]);
			} finally {
				await stmt.finalize();
			}
			expect(hex(await read(7))).toBe('11');
		});

		it('binds a view inside a transaction', async () => {
			await db.transaction(async (tx) => {
				await tx.execute(`INSERT INTO blobs VALUES (?, ?)`, [8, new Uint8Array(backing, 7, 1)]);
			});
			expect(hex(await read(8))).toBe('17');
		});

		it('binds a positional undefined as NULL', async () => {
			await db.execute(`INSERT INTO blobs VALUES (?, ?)`, [9, undefined]);
			expect(await read(9)).toBeNull();
		});

		it('binds a named undefined as NULL', async () => {
			await db.execute(`INSERT INTO blobs VALUES (:id, :b)`, { id: 10, b: undefined });
			expect(await read(10)).toBeNull();
		});

		describe('unsupported values', () => {
			it('rejects a Date bound positionally, naming its index', async () => {
				await expectAsync(db.execute(`INSERT INTO blobs VALUES (?, ?)`, [11, untyped(new Date())])).toBeRejectedWithError(TypeError, /index 1/);
				expect(await count()).toBe(0);
			});

			it('rejects a plain object bound by name, naming the parameter', async () => {
				await expectAsync(db.execute(`INSERT INTO blobs VALUES (:id, :b)`, { id: 11, b: untyped({}) })).toBeRejectedWithError(TypeError, /"b"/);
				expect(await count()).toBe(0);
			});

			it('rejects a bigint bound in a select, naming its index', async () => {
				await expectAsync(db.select(`SELECT ?`, [untyped(BigInt(1))])).toBeRejectedWithError(TypeError, /index 0/);
				expect(await count()).toBe(0);
			});

			it('throws from executeSync for a function value, naming its index', async () => {
				expect(() => db.executeSync(`INSERT INTO blobs VALUES (?, ?)`, [11, untyped(() => 0)])).toThrowError(TypeError, /index 1/);
				expect(await count()).toBe(0);
			});

			it('rejects a Date bound to a prepared statement, naming its index', async () => {
				const stmt = await db.prepare(`INSERT INTO blobs VALUES (?, ?)`);
				try {
					await expectAsync(stmt.execute([11, untyped(new Date())])).toBeRejectedWithError(TypeError, /index 1/);
				} finally {
					await stmt.finalize();
				}
				expect(await count()).toBe(0);
			});
		});
	});

	describe('selectArray and getArray', () => {
		let db: SQLiteDatabase;

		beforeEach(async () => {
			db = open('array');
			await db.execute(`CREATE TABLE arr (x INTEGER, y TEXT)`);
			await db.execute(`INSERT INTO arr VALUES (1, 'a')`);
			await db.execute(`INSERT INTO arr VALUES (2, 'b')`);
			await db.execute(`INSERT INTO arr VALUES (3, 'c')`);
		});

		it('selectArray returns the column names and one array per row', async () => {
			const result = await db.selectArray(`SELECT x, y FROM arr ORDER BY x`);
			expect(result.columns).toEqual(['x', 'y']);
			expect(result.rows.length).toBe(3);
			expect(result.rows[0]).toEqual([1, 'a']);
			expect(result.rows[2][0]).toBe(3);
		});

		it('getArray returns the single matching row', async () => {
			const single = await db.getArray(`SELECT x, y FROM arr WHERE x = ?`, [2]);
			expect(single.rows.length).toBe(1);
			expect(single.rows[0][0]).toBe(2);
		});

		it('getArray returns no rows when nothing matches', async () => {
			const none = await db.getArray(`SELECT x FROM arr WHERE x = 999`);
			expect(none.rows.length).toBe(0);
		});
	});

	describe('error handling', () => {
		let db: SQLiteDatabase;

		beforeEach(async () => {
			db = open('errors');
			await db.execute(`CREATE TABLE err (id INTEGER PRIMARY KEY, val TEXT UNIQUE NOT NULL)`);
			await db.execute(`INSERT INTO err VALUES (1, 'unique_val')`);
		});

		it('rejects malformed SQL with a SQLiteError carrying a numeric code and a message', async () => {
			const error = await rejectionOf(db.execute(`THIS IS NOT SQL`));
			expect(error).toEqual(jasmine.any(SQLiteError));
			expect(error).toEqual(jasmine.objectContaining({ code: jasmine.any(Number), message: jasmine.stringMatching(/./) }));
		});

		it('rejects a UNIQUE violation with SQLITE_CONSTRAINT', async () => {
			const error = await rejectionOf(db.execute(`INSERT INTO err VALUES (2, 'unique_val')`));
			expect(error).toEqual(jasmine.any(SQLiteError));
			expect(error).toEqual(jasmine.objectContaining({ code: SQLITE_CONSTRAINT }));
		});

		it('rejects a NOT NULL violation with a SQLiteError', async () => {
			await expectAsync(db.execute(`INSERT INTO err (id) VALUES (3)`)).toBeRejectedWithError(SQLiteError);
		});

		it('rejects a SELECT from a missing table with a SQLiteError', async () => {
			await expectAsync(db.select(`SELECT * FROM does_not_exist`)).toBeRejectedWithError(SQLiteError);
		});

		it('fails a statement on a closed database', async () => {
			const closed = open('closed');
			await closed.close();
			await expectAsync(attempt(() => closed.execute(`SELECT 1`))).toBeRejected();
		});
	});

	describe('runtime info', () => {
		it('reports the version, source id and compile options', async () => {
			const info = open('info').getRuntimeInfo();
			expect(info.version).toEqual(jasmine.any(String));
			expect(info.version.length).toBeGreaterThan(0);
			expect(info.sourceId).toEqual(jasmine.any(String));
			expect(info.compileOptions).toEqual(jasmine.any(Array));
		});
	});

	describe('in-memory database', () => {
		it('is open once opened', () => {
			expect(openInMemory().isOpen).toBeTrue();
		});

		it('stores and reads back data', async () => {
			const db = openInMemory();
			await db.execute(`CREATE TABLE mem (x INTEGER)`);
			await db.execute(`INSERT INTO mem VALUES (42)`);
			const r = await db.get<{ x: number }>(`SELECT x FROM mem`);
			expect(r?.x).toBe(42);
		});

		it('is no longer open after close()', async () => {
			const db = openInMemory();
			await db.execute(`CREATE TABLE mem (x INTEGER)`);
			await db.close();
			expect(db.isOpen).toBeFalse();
		});
	});
});
