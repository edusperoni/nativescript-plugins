import { openDatabase, SQLiteDatabase, SQLiteError, SQLITE_BUSY } from '@edusperoni/nativescript-sqlite';
import { closeQuietly, removeDbFiles, tempDbPath } from './helpers';

/**
 * Wraps `call` so that, if it returns a promise instead of throwing, the
 * promise's rejection is handled: an unhandled rejection aborts the Karma run.
 */
function swallowingReturnedPromise(call: () => unknown): () => unknown {
	return () => {
		const result = call();
		if (result && typeof (result as Promise<unknown>).then === 'function') {
			(result as Promise<unknown>).catch(() => undefined);
		}
		return result;
	};
}

describe('nativescript-sqlite: sync API and prepared statements', () => {
	let db: SQLiteDatabase | undefined;
	let path: string;

	function open(name: string): SQLiteDatabase {
		path = tempDbPath(name);
		db = openDatabase({ path });
		return db;
	}

	afterEach(async () => {
		await closeQuietly(db);
		db = undefined;
		if (path) removeDbFiles(path);
	});

	describe('prepared statements', () => {
		beforeEach(async () => {
			const d = open('spec_sync_prepared.db');
			await d.execute(`CREATE TABLE prep (id INTEGER PRIMARY KEY, name TEXT, score REAL)`);
			await d.execute(`INSERT INTO prep VALUES (1, 'Alice', 9.5)`);
			await d.execute(`INSERT INTO prep VALUES (2, 'Bob', 7.0)`);
			await d.execute(`INSERT INTO prep VALUES (3, 'Carol', 8.25)`);
		});

		it('selects with bound parameters and can be re-run with different ones', async () => {
			const stmt = await db!.prepare(`SELECT name, score FROM prep WHERE score > ? ORDER BY score DESC`);
			try {
				const high = await stmt.select<{ name: string; score: number }>([8.0]);
				expect(high.length).toBe(2);
				expect(high[0]?.name).toBe('Alice');

				const all = await stmt.select<{ name: string }>([0]);
				expect(all.length).toBe(3);
			} finally {
				await stmt.finalize();
			}
		});

		it('gets a single row, or undefined when nothing matches', async () => {
			const stmt = await db!.prepare(`SELECT score FROM prep WHERE id = ?`);
			try {
				const row = await stmt.get<{ score: number }>([2]);
				expect(row?.score).toBeCloseTo(7.0, 3);

				const missing = await stmt.get<{ score: number }>([999]);
				expect(missing).toBeUndefined();
			} finally {
				await stmt.finalize();
			}
		});

		it('selectArray returns every column and row', async () => {
			const stmt = await db!.prepare(`SELECT id, name, score FROM prep ORDER BY id`);
			try {
				const arr = await stmt.selectArray();
				expect(arr.columns.length).toBe(3);
				expect(arr.rows.length).toBe(3);
			} finally {
				await stmt.finalize();
			}
		});

		it('getArray returns the matching row', async () => {
			const stmt = await db!.prepare(`SELECT name, score FROM prep WHERE id = ?`);
			try {
				const arr = await stmt.getArray([1]);
				expect(arr.rows.length).toBe(1);
				expect(arr.rows[0]?.[0]).toBe('Alice');
			} finally {
				await stmt.finalize();
			}
		});

		it('executes inserts repeatedly with different parameters', async () => {
			const stmt = await db!.prepare(`INSERT INTO prep (id, name, score) VALUES (?, ?, ?)`);
			try {
				await stmt.execute([4, 'Dave', 6.5]);
				await stmt.execute([5, 'Eve', 9.9]);
			} finally {
				await stmt.finalize();
			}

			const count = await db!.get<{ n: number }>(`SELECT COUNT(*) AS n FROM prep`);
			expect(count?.n).toBe(5);
		});
	});

	describe('synchronous query methods', () => {
		beforeEach(() => {
			const d = open('spec_sync_api.db');
			d.executeSync(`CREATE TABLE sync_t (id INTEGER PRIMARY KEY, v TEXT)`);
			d.executeSync(`INSERT INTO sync_t VALUES (1, 'x')`);
			d.executeSync(`INSERT INTO sync_t VALUES (2, 'y')`);
		});

		it('selectSync returns every row written by executeSync', () => {
			const rows = db!.selectSync<{ id: number; v: string }>(`SELECT * FROM sync_t ORDER BY id`);
			expect(rows.length).toBe(2);
			expect(rows[0]?.v).toBe('x');
		});

		it('getSync returns the row matching bound parameters', () => {
			const row = db!.getSync<{ v: string }>(`SELECT v FROM sync_t WHERE id = ?`, [2]);
			expect(row?.v).toBe('y');
		});

		it('getSync returns undefined when nothing matches', () => {
			expect(db!.getSync(`SELECT * FROM sync_t WHERE id = 999`)).toBeUndefined();
		});

		it('selectArraySync returns column names and every row', () => {
			const arr = db!.selectArraySync(`SELECT id, v FROM sync_t ORDER BY id`);
			expect(arr.columns.length).toBe(2);
			expect(arr.rows.length).toBe(2);
			expect(arr.columns[0]).toBe('id');
		});

		// The query matches both rows, so this also pins getArraySync to one row
		// rather than letting it pass as an alias for selectArraySync.
		it('getArraySync returns only the first row of a multi-row result', () => {
			const arr = db!.getArraySync(`SELECT id, v FROM sync_t ORDER BY id`);
			expect(arr.rows.length).toBe(1);
			expect(arr.rows[0]?.[1]).toBe('x');
		});
	});

	describe('sync methods on a closed database', () => {
		beforeEach(async () => {
			await open('spec_sync_closed.db').close();
		});

		const cases: [string, (d: SQLiteDatabase) => unknown][] = [
			['executeSync', (d) => d.executeSync(`SELECT 1`)],
			['selectSync', (d) => d.selectSync(`SELECT 1`)],
			['selectArraySync', (d) => d.selectArraySync(`SELECT 1`)],
			['getSync', (d) => d.getSync(`SELECT 1`)],
			['getArraySync', (d) => d.getArraySync(`SELECT 1`)],
		];

		for (const [name, call] of cases) {
			it(`${name} throws synchronously`, () => {
				expect(swallowingReturnedPromise(() => call(db!))).toThrow();
			});
		}
	});

	describe('sync and async APIs sharing one writer', () => {
		beforeEach(async () => {
			await open('spec_sync_single_writer.db').execute(`CREATE TABLE w (id INTEGER PRIMARY KEY, v TEXT)`);
		});

		it('a sync read sees rows an open transaction has not committed yet', async () => {
			let seen: { v: string } | undefined;
			await db!.transaction(async (tx) => {
				await tx.execute(`INSERT INTO w VALUES (1, 'in-tx')`);
				seen = db!.getSync<{ v: string }>(`SELECT v FROM w WHERE id = 1`);
			});
			expect(seen?.v).toBe('in-tx');
		}, 30000);

		it('refuses executeSync during a transaction with SQLITE_BUSY, immediately, and accepts it after the commit', async () => {
			let error: unknown;
			let elapsed = -1;
			await db!.transaction(async (tx) => {
				await tx.execute(`INSERT INTO w VALUES (1, 'in-tx')`);
				const t0 = Date.now();
				try {
					db!.executeSync(`INSERT INTO w VALUES (2, 'sync')`);
				} catch (e) {
					error = e;
				}
				elapsed = Date.now() - t0;
			});

			expect(error).toBeInstanceOf(SQLiteError);
			expect((error as SQLiteError | undefined)?.code).toBe(SQLITE_BUSY);
			// Anything near the busy timeout means it waited for the lock instead of refusing.
			expect(elapsed).toBeLessThan(50);

			db!.executeSync(`INSERT INTO w VALUES (2, 'after')`);
			const count = db!.getSync<{ n: number }>(`SELECT count(*) AS n FROM w`);
			expect(count?.n).toBe(2);
		}, 30000);
	});

	describe('ordering of sync calls behind queued async work', () => {
		beforeEach(async () => {
			await open('spec_sync_ordering.db').execute(`CREATE TABLE o (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)`);
		});

		it('a sync read after un-awaited async writes sees all of them', async () => {
			const writes: Promise<void>[] = [];
			for (let i = 0; i < 50; i++) writes.push(db!.execute(`INSERT INTO o (v) VALUES (?)`, [i]));
			const settled = Promise.allSettled(writes);

			let mid: { n: number } | undefined;
			try {
				mid = db!.getSync<{ n: number }>(`SELECT count(*) AS n FROM o`);
			} finally {
				await settled;
			}
			expect(mid?.n).toBe(50);
			await expectAsync(Promise.all(writes)).toBeResolved();
		}, 30000);

		it('interleaved sync and async writes all land', async () => {
			const writes: Promise<void>[] = [];
			try {
				for (let i = 0; i < 40; i++) {
					if (i % 2 === 0) db!.executeSync(`INSERT INTO o (v) VALUES (?)`, [i]);
					else writes.push(db!.execute(`INSERT INTO o (v) VALUES (?)`, [i]));
				}
			} finally {
				await Promise.allSettled(writes);
			}
			await expectAsync(Promise.all(writes)).toBeResolved();

			const total = db!.getSync<{ n: number }>(`SELECT count(*) AS n FROM o`);
			expect(total?.n).toBe(40);
		}, 30000);
	});

	describe('sync calls from continuations and callbacks', () => {
		beforeEach(async () => {
			await open('spec_sync_reentrancy.db').execute(`CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT)`);
		});

		it('sync writes and reads work from inside an awaited continuation', async () => {
			await db!.execute(`INSERT INTO r VALUES (1, 'async')`);
			db!.executeSync(`INSERT INTO r VALUES (2, 'sync-in-continuation')`);
			const row = db!.getSync<{ v: string }>(`SELECT v FROM r WHERE id = 2`);
			expect(row?.v).toBe('sync-in-continuation');
		});

		it("sync reads work from inside transaction()'s callback", async () => {
			await db!.execute(`INSERT INTO r VALUES (1, 'async')`);
			db!.executeSync(`INSERT INTO r VALUES (2, 'sync-in-continuation')`);

			let inTx: { n: number } | undefined;
			await db!.transaction(async (tx) => {
				await tx.execute(`INSERT INTO r VALUES (3, 'in-tx')`);
				inTx = db!.getSync<{ n: number }>(`SELECT count(*) AS n FROM r`);
			});
			expect(inTx?.n).toBe(3);
		}, 30000);
	});
});
