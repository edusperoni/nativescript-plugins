import { File } from '@nativescript/core';
import { DatabaseOptions, OpenStep, OpenStepScope, openDatabase, SQLiteDatabase, SQLiteError, SQLITE_MISUSE } from '@edusperoni/nativescript-sqlite';
import { closeQuietly, tempDbPath } from './helpers';

describe('nativescript-sqlite: opening', () => {
	const opened: SQLiteDatabase[] = [];

	function open(options: DatabaseOptions): SQLiteDatabase {
		const db = openDatabase(options);
		opened.push(db);
		return db;
	}

	/** The error `openDatabase(options)` throws, or undefined when it opens. */
	function openError(options: DatabaseOptions): unknown {
		try {
			open(options);
		} catch (e) {
			return e;
		}
		return undefined;
	}

	afterEach(async () => {
		await Promise.all(opened.splice(0).map((db) => closeQuietly(db)));
	});

	describe('onOpen statements', () => {
		// foreign_keys is per-connection and off by default, so reading it back
		// tells which connections actually ran the statement.
		function openWithForeignKeys(name: string): SQLiteDatabase {
			return open({ path: tempDbPath(name), poolSize: 2, serialized: false, onOpen: ['PRAGMA foreign_keys=ON'] });
		}

		it('run on the writer connection', async () => {
			const db = openWithForeignKeys('spec_open_onopen_writer.db');
			await db.transaction(async (tx) => {
				const row = await tx.get<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
				expect(row?.foreign_keys).toBe(1);
			});
		});

		it('run on every reader connection', async () => {
			const db = openWithForeignKeys('spec_open_onopen_readers.db');
			for (let i = 0; i < 4; i++) {
				const row = await db.get<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
				expect(row?.foreign_keys).withContext(`reader ${i}`).toBe(1);
			}
		});

		it('run on the sync connection', () => {
			const db = openWithForeignKeys('spec_open_onopen_sync.db');
			const row = db.getSync<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
			expect(row?.foreign_keys).toBe(1);
		});

		it('abort the open with a SQLiteError when one fails', () => {
			const err = openError({ path: tempDbPath('spec_open_onopen_fail.db'), onOpen: ['SELECT * FROM table_that_does_not_exist'] });
			expect(err).toBeInstanceOf(SQLiteError);
		});
	});

	describe('serialized mode', () => {
		let db: SQLiteDatabase;

		beforeEach(async () => {
			db = open({ path: tempDbPath('spec_open_serialized.db'), serialized: true });
			await db.execute(`CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)`);
			await db.execute(`INSERT INTO s VALUES (1, 'a')`);
		});

		it('serves async selects without a reader pool', async () => {
			const rows = await db.select<{ v: string }>(`SELECT v FROM s ORDER BY id`);
			expect(rows.length).toBe(1);
			expect(rows[0].v).toBe('a');
		});

		it('sees transaction writes from the transaction, the sync API and prepared statements', async () => {
			await db.transaction(async (tx) => {
				await tx.execute(`INSERT INTO s VALUES (2, 'b')`);
				const seen = await tx.select(`SELECT v FROM s`);
				expect(seen.length).withContext('read inside its own transaction').toBe(2);
			});

			const count = db.getSync<{ n: number }>(`SELECT COUNT(*) AS n FROM s`);
			expect(count?.n).withContext('sync read').toBe(2);

			const stmt = await db.prepare(`SELECT v FROM s WHERE id = ?`);
			try {
				const prepared = await stmt.select<{ v: string }>([2]);
				expect(prepared[0].v).withContext('prepared statement').toBe('b');
			} finally {
				await stmt.finalize();
			}
		});
	});

	// The key is resolved in JavaScript before it reaches SQLite, so these hold without a codec.
	describe('encryptionKeyFormat validation', () => {
		const rawHex = 'a'.repeat(64);

		it("rejects a key shaped like x'<hex>' without encryptionKeyFormat: 'raw'", () => {
			const err = openError({ path: tempDbPath('spec_open_keyfmt_rawshape.db'), encryptionKey: `x'${rawHex}'` });
			expect(err).toBeInstanceOf(Error);
		});

		it('rejects a raw key that is not 64 or 96 hex digits', () => {
			const err = openError({ path: tempDbPath('spec_open_keyfmt_malformed.db'), encryptionKey: 'not-hex', encryptionKeyFormat: 'raw' });
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe('asyncOpen', () => {
		it('returns immediately, reports isOpen while opening, and initialized() resolves', async () => {
			const t0 = Date.now();
			const db = open({ path: tempDbPath('spec_open_async_immediate.db'), asyncOpen: true });
			const openMs = Date.now() - t0;
			expect(db.isOpen).toBeTrue();
			expect(openMs).withContext('openDatabase() duration in ms').toBeLessThan(50);
			await expectAsync(db.initialized()).toBeResolved();
		});

		it('is usable once initialized() resolves', async () => {
			const db = open({ path: tempDbPath('spec_open_async_usable.db'), asyncOpen: true });
			await db.initialized();
			await db.execute(`CREATE TABLE a (x INTEGER)`);
			await db.execute(`INSERT INTO a VALUES (1)`);
			const row = await db.get<{ x: number }>(`SELECT x FROM a`);
			expect(row?.x).toBe(1);
		});

		it('blocks a sync call made before initialization until the open completes', () => {
			const db = open({ path: tempDbPath('spec_open_async_sync.db'), asyncOpen: true });
			db.executeSync(`CREATE TABLE b (x INTEGER)`);
			db.executeSync(`INSERT INTO b VALUES (7)`);
			expect(db.getSync<{ x: number }>(`SELECT x FROM b`)?.x).toBe(7);
		});

		// Awaiting initialized() is documented as optional, so a read issued before
		// the connections are open has to queue rather than be turned away.
		it('queues a pooled read issued before initialization', async () => {
			const db = open({ path: tempDbPath('spec_open_async_pooled.db'), asyncOpen: true, poolSize: 2 });
			await db.execute(`CREATE TABLE c (x INTEGER)`);
			await db.execute(`INSERT INTO c VALUES (3)`);
			const rows = await db.select<{ x: number }>(`SELECT x FROM c`);
			expect(rows.length).toBe(1);
			expect(rows[0].x).toBe(3);
		});

		it('survives being closed immediately after opening, 50 times', async () => {
			for (let i = 0; i < 50; i++) {
				const db = open({ path: tempDbPath('spec_open_async_loop.db'), asyncOpen: true });
				await expectAsync(db.close()).withContext(`round ${i}`).toBeResolved();
			}
		}, 60000);
	});

	// Validation happens before SQLite is involved, so these hold without a codec.
	describe('openSequence validation', () => {
		const cases: { name: string; file: string; options: (path: string) => DatabaseOptions }[] = [
			{
				name: 'onOpen together with openSequence',
				file: 'spec_open_seq_both.db',
				options: (path) => ({ path, onOpen: ['PRAGMA user_version = 1'], openSequence: [OpenStep.key, OpenStep.wal] }),
			},
			{
				name: 'a repeated key step',
				file: 'spec_open_seq_dupkey.db',
				options: (path) => ({ path, openSequence: [OpenStep.key, OpenStep.key, OpenStep.wal] }),
			},
			{
				name: 'a repeated wal step',
				file: 'spec_open_seq_dupwal.db',
				options: (path) => ({ path, openSequence: [OpenStep.key, OpenStep.wal, OpenStep.wal] }),
			},
			{
				name: 'a wal step before the key step when a key is set',
				file: 'spec_open_seq_order.db',
				options: (path) => ({ path, encryptionKey: 'some-key', openSequence: [OpenStep.wal, OpenStep.key] }),
			},
			{
				name: 'a step with an unknown scope',
				file: 'spec_open_seq_scope.db',
				options: (path) => ({ path, openSequence: [OpenStep.key, { sql: 'PRAGMA user_version = 1', on: 'nobody' as unknown as OpenStepScope }, OpenStep.wal] }),
			},
		];

		for (const c of cases) {
			it(`rejects ${c.name} with SQLITE_MISUSE`, () => {
				const err = openError(c.options(tempDbPath(c.file)));
				expect(err).toBeInstanceOf(SQLiteError);
				expect((err as SQLiteError | undefined)?.code).toBe(SQLITE_MISUSE);
			});
		}

		it('rejects an encryptionKey without a key step with SQLITE_MISUSE, creating no file', () => {
			const path = tempDbPath('spec_open_seq_nokey.db');
			const err = openError({ path, encryptionKey: 'some-key', openSequence: [OpenStep.wal] });
			expect(err).toBeInstanceOf(SQLiteError);
			expect((err as SQLiteError | undefined)?.code).toBe(SQLITE_MISUSE);
			expect(File.exists(path)).withContext('database file created by a refused sequence').toBeFalse();
		});
	});

	describe('openSequence behaviour', () => {
		function openDefaultAndExplicit(name: string): { viaOnOpen: SQLiteDatabase; viaSequence: SQLiteDatabase } {
			return {
				viaOnOpen: open({ path: tempDbPath(`spec_open_seq_${name}_onopen.db`), onOpen: ['PRAGMA user_version = 7'] }),
				viaSequence: open({ path: tempDbPath(`spec_open_seq_${name}_explicit.db`), openSequence: [OpenStep.key, 'PRAGMA user_version = 7', OpenStep.wal] }),
			};
		}

		it('runs onOpen statements and the equivalent explicit sequence alike', () => {
			const { viaOnOpen, viaSequence } = openDefaultAndExplicit('stmt');
			expect(viaOnOpen.getSync<{ user_version: number }>(`PRAGMA user_version`)?.user_version).withContext('onOpen').toBe(7);
			expect(viaSequence.getSync<{ user_version: number }>(`PRAGMA user_version`)?.user_version).withContext('openSequence').toBe(7);
		});

		it('switches to WAL both with onOpen and with an explicit wal step', () => {
			const { viaOnOpen, viaSequence } = openDefaultAndExplicit('wal');
			expect(viaOnOpen.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)?.journal_mode).withContext('onOpen').toBe('wal');
			expect(viaSequence.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)?.journal_mode).withContext('openSequence').toBe('wal');
		});

		it('leaves a new file in rollback-journal mode without a wal step', async () => {
			const db = open({ path: tempDbPath('spec_open_seq_nowal.db'), openSequence: [OpenStep.key], serialized: true });
			await db.execute(`CREATE TABLE t (x INTEGER)`);
			expect(db.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)?.journal_mode).toBe('delete');
		});

		it('applies a writer-scoped page_size placed before the wal step on a new file', async () => {
			const db = open({ path: tempDbPath('spec_open_seq_page.db'), openSequence: [OpenStep.key, { sql: 'PRAGMA page_size = 8192', on: 'writer' }, OpenStep.wal] });
			await db.execute(`CREATE TABLE t (x INTEGER)`);
			expect(db.getSync<{ page_size: number }>(`PRAGMA page_size`)?.page_size).toBe(8192);
			expect(db.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)?.journal_mode).toBe('wal');
		});

		it('runs writer-scoped steps on the writer and reader-scoped steps on every reader', async () => {
			const db = open({
				path: tempDbPath('spec_open_seq_scoped.db'),
				poolSize: 2,
				serialized: false,
				openSequence: [OpenStep.key, { sql: 'PRAGMA cache_size = -1234', on: 'readers' }, { sql: 'PRAGMA cache_size = -4321', on: 'writer' }, OpenStep.wal],
			});
			// A sync read runs on the writer; an async read goes to a reader.
			expect(db.getSync<{ cache_size: number }>(`PRAGMA cache_size`)?.cache_size).withContext('writer').toBe(-4321);
			for (let i = 0; i < 4; i++) {
				const seen = await db.get<{ cache_size: number }>(`PRAGMA cache_size`);
				expect(seen?.cache_size).withContext(`reader ${i}`).toBe(-1234);
			}
		});

		// SQLite's own diagnostic still names the object it could not resolve, which
		// is worth keeping; what must not appear is the statement the caller wrote.
		it('reports a failing step by its index without quoting the statement', () => {
			const failingSql = 'SELECT nosuchcolumn FROM sqlite_schema';
			const err = openError({ path: tempDbPath('spec_open_seq_fail.db'), openSequence: [OpenStep.key, failingSql, OpenStep.wal] });
			expect(err).toBeInstanceOf(SQLiteError);
			const { code, message } = err as SQLiteError;
			expect(code).toEqual(jasmine.any(Number));
			expect(code).not.toBe(0);
			expect(message).toMatch(/open step 1 failed/);
			expect(message).not.toContain(failingSql);
		});
	});

	describe('openSequence under asyncOpen with a pool', () => {
		it('runs the writer steps on a fresh file before any reader touches it, 30 times', async () => {
			for (let i = 0; i < 30; i++) {
				const db = open({
					path: tempDbPath('spec_open_seq_writerfirst.db'),
					asyncOpen: true,
					poolSize: 4,
					openSequence: [OpenStep.key, { sql: 'PRAGMA page_size = 8192', on: 'writer' }, OpenStep.wal],
				});
				try {
					await db.initialized();
					await db.execute(`CREATE TABLE t (x INTEGER)`);
					expect(db.getSync<{ page_size: number }>(`PRAGMA page_size`)?.page_size).withContext(`round ${i}: page_size`).toBe(8192);
					expect(db.getSync<{ journal_mode: string }>(`PRAGMA journal_mode`)?.journal_mode).withContext(`round ${i}: journal_mode`).toBe('wal');
					for (let r = 0; r < 4; r++) {
						const row = await db.get<{ n: number }>(`SELECT count(*) AS n FROM t`);
						expect(row?.n).withContext(`round ${i}: pooled read ${r}`).toBe(0);
					}
				} finally {
					await db.close();
				}
			}
		}, 60000);
	});
});
