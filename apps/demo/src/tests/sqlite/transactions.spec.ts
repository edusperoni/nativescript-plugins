import { openDatabase, SQLiteDatabase, SQLiteError, SQLITE_BUSY, SQLITE_MISUSE } from '@edusperoni/nativescript-sqlite';
import { closeQuietly, removeDbFiles, tempDbPath } from './helpers';

const TIMEOUT = 30000;

/** What `fn` throws, or `undefined` if it returns normally. */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

describe('nativescript-sqlite: transactions', () => {
	let path: string;
	let db: SQLiteDatabase;

	function openFresh(name: string, schema: string): Promise<void> {
		path = tempDbPath(name);
		db = openDatabase({ path });
		return db.execute(schema);
	}

	afterEach(async () => {
		await closeQuietly(db);
		removeDbFiles(path);
	}, TIMEOUT);

	describe('transaction() and readTransaction()', () => {
		beforeEach(async () => {
			await openFresh('spec_tx_async.db', `CREATE TABLE acct (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)`);
			await db.execute(`INSERT INTO acct VALUES (1, 1000)`);
			await db.execute(`INSERT INTO acct VALUES (2, 500)`);
		}, TIMEOUT);

		it(
			'sees its own writes before commit and commits them',
			async () => {
				let midTx: number | undefined;
				await db.transaction(async (tx) => {
					await tx.execute(`UPDATE acct SET balance = balance - 200 WHERE id = 1`);
					await tx.execute(`UPDATE acct SET balance = balance + 200 WHERE id = 2`);
					midTx = (await tx.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 1`))?.balance;
				});
				expect(midTx).toBe(800);
				expect((await db.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 1`))?.balance).toBe(800);
			},
			TIMEOUT,
		);

		it(
			'rolls back and rejects when the callback throws',
			async () => {
				await expectAsync(
					db.transaction(async (tx) => {
						await tx.execute(`UPDATE acct SET balance = balance - 200 WHERE id = 2`);
						throw new Error('deliberate rollback');
					}),
				).toBeRejectedWithError(Error, /deliberate rollback/);
				expect((await db.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 2`))?.balance).toBe(500);
			},
			TIMEOUT,
		);

		it(
			'readTransaction reads the committed rows',
			async () => {
				const rows = await db.readTransaction((tx) => tx.select<{ id: number }>(`SELECT id FROM acct ORDER BY id`));
				expect(rows.length).toBe(2);
			},
			TIMEOUT,
		);

		it(
			'a failed savepoint rolls back only its own writes',
			async () => {
				let afterSavepoint: number | undefined;
				await db.transaction(async (tx) => {
					await tx.execute(`UPDATE acct SET balance = 9999 WHERE id = 1`);
					await expectAsync(
						tx.savepoint(async (inner) => {
							await inner.execute(`UPDATE acct SET balance = 1 WHERE id = 1`);
							throw new Error('savepoint rollback');
						}),
					).toBeRejectedWithError(Error, /savepoint rollback/);
					afterSavepoint = (await tx.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 1`))?.balance;
				});
				expect(afterSavepoint).toBe(9999);
			},
			TIMEOUT,
		);

		it(
			'resolves with the callback return value',
			async () => {
				const result = await db.transaction(async (tx) => (await tx.get<{ balance: number }>(`SELECT balance FROM acct WHERE id = 2`))?.balance);
				expect(result).toBe(500);
			},
			TIMEOUT,
		);
	});

	describe('beginTransaction() / commitTransaction() / rollbackTransaction()', () => {
		beforeEach(() => openFresh('spec_tx_lowlevel.db', `CREATE TABLE ll (id INTEGER PRIMARY KEY, v TEXT)`), TIMEOUT);

		it(
			'an immediate transaction sees its own writes and commits them',
			async () => {
				const txId = await db.beginTransaction('immediate');
				await db.executeInTransaction(txId, `INSERT INTO ll VALUES (1, 'committed')`);
				const mid = await db.selectInTransaction(txId, `SELECT v FROM ll WHERE id = 1`);
				expect(mid[0]?.v).toBe('committed');
				await db.commitTransaction(txId);
				expect((await db.get<{ v: string }>(`SELECT v FROM ll WHERE id = 1`))?.v).toBe('committed');
			},
			TIMEOUT,
		);

		it(
			'rollbackTransaction discards the writes',
			async () => {
				const txId = await db.beginTransaction();
				await db.executeInTransaction(txId, `INSERT INTO ll VALUES (2, 'rolled_back')`);
				await db.rollbackTransaction(txId);
				expect(await db.get(`SELECT * FROM ll WHERE id = 2`)).toBeUndefined();
			},
			TIMEOUT,
		);

		it(
			'selectArrayInTransaction returns columns and rows',
			async () => {
				const txId = await db.beginTransaction();
				await db.executeInTransaction(txId, `INSERT INTO ll VALUES (3, 'arr')`);
				const result = await db.selectArrayInTransaction(txId, `SELECT id, v FROM ll ORDER BY id`);
				expect(result.columns.length).toBe(2);
				expect(result.rows.length).toBeGreaterThanOrEqual(1);
				await db.commitTransaction(txId);
			},
			TIMEOUT,
		);
	});

	describe('sync methods inside transactions', () => {
		beforeEach(() => openFresh('spec_tx_syncmethods.db', `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`), TIMEOUT);

		it(
			"a transaction's getSync sees its executeSync writes, which commit with it",
			async () => {
				let seen: string | undefined;
				await db.transaction(async (tx) => {
					tx.executeSync(`INSERT INTO t VALUES (1, 'a')`);
					seen = tx.getSync<{ v: string }>(`SELECT v FROM t WHERE id = 1`)?.v;
				});
				expect(seen).toBe('a');
				expect((await db.get<{ v: string }>(`SELECT v FROM t WHERE id = 1`))?.v).toBe('a');
			},
			TIMEOUT,
		);

		it(
			"a transaction's executeSync writes roll back with it",
			async () => {
				await expectAsync(
					db.transaction(async (tx) => {
						tx.executeSync(`INSERT INTO t VALUES (2, 'b')`);
						throw new Error('rollback please');
					}),
				).toBeRejectedWithError(Error, /rollback please/);
				expect(await db.get(`SELECT v FROM t WHERE id = 2`)).toBeUndefined();
			},
			TIMEOUT,
		);

		it(
			'a finished transaction object throws SQLITE_MISUSE',
			async () => {
				const escaped = await db.transaction(async (tx) => tx);
				const error = thrownBy(() => escaped.executeSync(`INSERT INTO t VALUES (3, 'c')`));
				expect(error).toBeInstanceOf(SQLiteError);
				expect(error).toEqual(jasmine.objectContaining({ code: SQLITE_MISUSE }));
			},
			TIMEOUT,
		);

		it(
			'executeInTransactionSync, selectInTransactionSync and selectArrayInTransactionSync run in a low-level transaction',
			async () => {
				const txId = await db.beginTransaction();
				db.executeInTransactionSync(txId, `INSERT INTO t VALUES (4, 'd')`);
				expect(db.selectInTransactionSync(txId, `SELECT v FROM t WHERE id = 4`)[0]?.v).toBe('d');
				expect(db.selectArrayInTransactionSync(txId, `SELECT id, v FROM t WHERE id = 4`).columns.length).toBe(2);
				await db.commitTransaction(txId);
			},
			TIMEOUT,
		);

		it(
			'executeInTransactionSync throws SQLITE_MISUSE for an unknown txId',
			() => {
				const error = thrownBy(() => db.executeInTransactionSync(999999, `SELECT 1`));
				expect(error).toEqual(jasmine.objectContaining({ code: SQLITE_MISUSE }));
			},
			TIMEOUT,
		);
	});

	describe('transactionSync()', () => {
		beforeEach(() => openFresh('spec_tx_sync.db', `CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)`), TIMEOUT);

		async function valueOf(id: number): Promise<string | undefined> {
			return (await db.get<{ v: string }>(`SELECT v FROM s WHERE id = ${id}`))?.v;
		}

		it(
			'commits and returns the callback value',
			async () => {
				const returned = db.transactionSync((tx) => {
					tx.executeSync(`INSERT INTO s VALUES (1, 'one')`);
					return tx.getSync<{ v: string }>(`SELECT v FROM s WHERE id = 1`)?.v;
				});
				expect(returned).toBe('one');
				expect(await valueOf(1)).toBe('one');
			},
			TIMEOUT,
		);

		it(
			'rolls back and rethrows the original error when the callback throws',
			async () => {
				const sentinel = new Error('boom');
				const caught = thrownBy(() =>
					db.transactionSync((tx) => {
						tx.executeSync(`INSERT INTO s VALUES (2, 'two')`);
						throw sentinel;
					}),
				);
				expect(caught).toBe(sentinel);
				expect(await valueOf(2)).toBeUndefined();
			},
			TIMEOUT,
		);

		it(
			'throws when the callback returns a promise',
			() => {
				expect(() => db.transactionSync((() => Promise.resolve(1)) as unknown as () => number)).toThrowError(SQLiteError, /synchronous callback/);
			},
			TIMEOUT,
		);

		it(
			'savepointSync rolls back only its own writes',
			async () => {
				db.transactionSync((tx) => {
					tx.executeSync(`INSERT INTO s VALUES (3, 'three')`);
					expect(() =>
						tx.savepointSync((sp) => {
							sp.executeSync(`INSERT INTO s VALUES (4, 'four')`);
							throw new Error('nested');
						}),
					).toThrowError(/nested/);
				});
				expect(await valueOf(3)).toBe('three');
				expect(await valueOf(4)).toBeUndefined();
			},
			TIMEOUT,
		);

		it(
			'runs async work started inside the callback after the transaction, outside it',
			async () => {
				let dispatched: Promise<void> | undefined;
				expect(() =>
					db.transactionSync((tx) => {
						tx.executeSync(`INSERT INTO s VALUES (5, 'five')`);
						dispatched = db.execute(`INSERT INTO s VALUES (6, 'six')`);
						throw new Error('rollback');
					}),
				).toThrowError(/rollback/);
				await dispatched;
				expect(await valueOf(5)).toBeUndefined();
				expect(await valueOf(6)).toBe('six');
			},
			TIMEOUT,
		);

		it(
			'sees writes queued before it',
			async () => {
				const queued = db.execute(`INSERT INTO s VALUES (7, 'seven')`);
				let sawSeven: boolean;
				try {
					sawSeven = db.transactionSync((tx) => tx.getSync(`SELECT v FROM s WHERE id = 7`) != null);
				} finally {
					await queued;
				}
				expect(sawSeven).toBeTrue();
			},
			TIMEOUT,
		);

		it(
			'is refused immediately with SQLITE_BUSY while an async transaction is open',
			async () => {
				let error: unknown;
				let elapsed = 0;
				await db.transaction(async () => {
					const t0 = Date.now();
					error = thrownBy(() => db.transactionSync(() => undefined));
					elapsed = Date.now() - t0;
				});
				expect(error).toEqual(jasmine.objectContaining({ code: SQLITE_BUSY }));
				expect(elapsed).toBeLessThan(50);
			},
			TIMEOUT,
		);

		it(
			'leaves the database usable after failed and refused sync transactions',
			async () => {
				expect(() =>
					db.transactionSync((tx) => {
						tx.executeSync(`INSERT INTO s VALUES (2, 'two')`);
						throw new Error('boom');
					}),
				).toThrowError(/boom/);
				expect(() => db.transactionSync((() => Promise.resolve(1)) as unknown as () => number)).toThrow();
				await db.transaction(async () => {
					expect(() => db.transactionSync(() => undefined)).toThrow();
				});

				db.executeSync(`INSERT INTO s VALUES (8, 'eight')`);
				await db.execute(`INSERT INTO s VALUES (9, 'nine')`);
				expect(await valueOf(8)).toBe('eight');
				expect(await valueOf(9)).toBe('nine');
			},
			TIMEOUT,
		);
	});

	describe('executeSync({ joinTransaction: true })', () => {
		beforeEach(() => openFresh('spec_tx_join.db', `CREATE TABLE j (id INTEGER PRIMARY KEY, v TEXT)`), TIMEOUT);

		async function valueOf(id: number): Promise<string | undefined> {
			return (await db.get<{ v: string }>(`SELECT v FROM j WHERE id = ${id}`))?.v;
		}

		it(
			'commits with the open transaction',
			async () => {
				await db.transaction(async () => {
					db.executeSync(`INSERT INTO j VALUES (1, 'joined')`, undefined, { joinTransaction: true });
				});
				expect(await valueOf(1)).toBe('joined');
			},
			TIMEOUT,
		);

		it(
			'rolls back with the open transaction',
			async () => {
				await expectAsync(
					db.transaction(async () => {
						db.executeSync(`INSERT INTO j VALUES (2, 'joined')`, undefined, { joinTransaction: true });
						throw new Error('rollback');
					}),
				).toBeRejectedWithError(Error, /^rollback$/);
				expect(await valueOf(2)).toBeUndefined();
			},
			TIMEOUT,
		);

		it(
			'behaves like a plain executeSync when no transaction is open',
			async () => {
				db.executeSync(`INSERT INTO j VALUES (3, 'plain')`, undefined, { joinTransaction: true });
				expect(await valueOf(3)).toBe('plain');
			},
			TIMEOUT,
		);
	});
});
