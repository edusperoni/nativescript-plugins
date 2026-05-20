import { DatabaseOptions, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue } from './common';
import type { PreparedStatement, ReadTransaction, SQLiteDatabase, Transaction } from '.';

export { DatabaseOptions, SQLiteArrayResult, SQLiteError, SQLiteParams, SQLiteRow, SQLiteValue };
export type { PreparedStatement, ReadTransaction, SQLiteDatabase, Transaction };
export * from './common';

declare class NSSQLiteDatabase extends NSObject {
	static openWithPathPoolSizeReadOnlyBusyTimeoutEncryptionKey(path: string, poolSize: number, readOnly: boolean, busyTimeout: number, encryptionKey: string | null): NSSQLiteDatabase;

	executeParamsCompletion(sql: string, params: NSArray<any>, completion: (error: NSError) => void): void;
	selectParamsCompletion(sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayParamsCompletion(sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;

	beginTransactionCompletion(behavior: string, completion: (txId: number, error: NSError) => void): void;
	executeInTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (error: NSError) => void): void;
	selectInTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayInTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	commitTransactionCompletion(txId: number, completion: (error: NSError) => void): void;
	rollbackTransactionCompletion(txId: number, completion: (error: NSError) => void): void;

	beginReadTransaction(completion: (txId: number, error: NSError) => void): void;
	selectInReadTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayInReadTransactionSqlParamsCompletion(txId: number, sql: string, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	endReadTransactionCompletion(txId: number, completion: (error: NSError) => void): void;

	prepareCompletion(sql: string, completion: (stmtId: number, error: NSError) => void): void;
	executePreparedParamsCompletion(stmtId: number, params: NSArray<any>, completion: (error: NSError) => void): void;
	selectPreparedParamsCompletion(stmtId: number, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	selectArrayPreparedParamsCompletion(stmtId: number, params: NSArray<any>, completion: (json: string, blobs: NSArray<NSData>, error: NSError) => void): void;
	finalizePreparedCompletion(stmtId: number, completion: (error: NSError) => void): void;

	executeSyncParamsError(sql: string, params: NSArray<any>): boolean;
	selectSyncParamsError(sql: string, params: NSArray<any>): string;
	selectArraySyncParamsError(sql: string, params: NSArray<any>): string;

	closeWithCompletion(completion: () => void): void;
	close(): void;
	isOpen: boolean;
}

function toNSError(error: NSError): SQLiteError {
	const extCode = error.userInfo?.objectForKey?.('extendedCode') as number | undefined;
	return new SQLiteError(error.localizedDescription, error.code, extCode ?? error.code);
}

function marshalParams(params?: SQLiteParams): NSArray<any> {
	if (!params) return NSArray.new<any>();
	if (Array.isArray(params)) {
		return NSArray.arrayWithArray(
			params.map((v) => {
				if (v === null || v === undefined) return NSNull.null();
				if (typeof v === 'boolean') return NSNumber.numberWithBool(v);
				if (typeof v === 'number') return NSNumber.numberWithDouble(v);
				if (typeof v === 'string') return v as any;
				if (v instanceof ArrayBuffer) return NSData.dataWithData(v as any);
				return NSNull.null();
			}),
		);
	}
	const dict = NSMutableDictionary.new<string, any>();
	for (const key of Object.keys(params)) {
		const v = (params as Record<string, SQLiteValue>)[key];
		if (v === null || v === undefined) {
			dict.setObjectForKey(NSNull.null(), key);
		} else if (typeof v === 'boolean') {
			dict.setObjectForKey(NSNumber.numberWithBool(v), key);
		} else if (typeof v === 'number') {
			dict.setObjectForKey(NSNumber.numberWithDouble(v), key);
		} else if (typeof v === 'string') {
			dict.setObjectForKey(v as any, key);
		} else if (v instanceof ArrayBuffer) {
			dict.setObjectForKey(NSData.dataWithData(v as any), key);
		} else {
			dict.setObjectForKey(NSNull.null(), key);
		}
	}
	return NSArray.arrayWithObject(dict);
}

function parseSelectResult<T>(json: string, blobs: NSArray<NSData> | null): T {
	const rows = JSON.parse(json);
	if (blobs && blobs.count > 0) {
		hydrateBlobs(rows, blobs);
	}
	return rows;
}

function hydrateBlobs(rows: any[], blobs: NSArray<NSData>): void {
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			const val = row[key];
			if (val && typeof val === 'object' && '__blob__' in val) {
				const nsData = blobs.objectAtIndex(val.__blob__);
				row[key] = interop.bufferFromData(nsData);
			}
		}
	}
}

function parseArrayResult<T extends SQLiteValue[]>(json: string, blobs: NSArray<NSData> | null): SQLiteArrayResult<T> {
	const result = JSON.parse(json) as SQLiteArrayResult<T>;
	if (blobs && blobs.count > 0) {
		for (const row of result.rows) {
			for (let i = 0; i < row.length; i++) {
				const val = row[i] as any;
				if (val && typeof val === 'object' && '__blob__' in val) {
					const nsData = blobs.objectAtIndex(val.__blob__);
					(row as any)[i] = interop.bufferFromData(nsData);
				}
			}
		}
	}
	return result;
}

class WriteTxImpl implements Transaction {
	constructor(
		private native: NSSQLiteDatabase,
		private txId: number,
		private _savepointCounter: { value: number },
	) {}

	execute(sql: string, params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executeInTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectInTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayInTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(sql, params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(sql, params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}

	async savepoint<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const name = `sp_${this._savepointCounter.value++}`;
		await this.execute(`SAVEPOINT ${name}`);
		try {
			const result = await fn(this);
			await this.execute(`RELEASE ${name}`);
			return result;
		} catch (e) {
			await this.execute(`ROLLBACK TO ${name}`);
			throw e;
		}
	}
}

class ReadTxImpl implements ReadTransaction {
	constructor(
		private native: NSSQLiteDatabase,
		private txId: number,
	) {}

	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectInReadTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayInReadTransactionSqlParamsCompletion(this.txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(sql, params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(sql, params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}
}

class PreparedStatementImpl implements PreparedStatement {
	constructor(
		private native: NSSQLiteDatabase,
		private stmtId: number,
	) {}

	execute(params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executePreparedParamsCompletion(this.stmtId, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	select<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectPreparedParamsCompletion(this.stmtId, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayPreparedParamsCompletion(this.stmtId, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}

	finalize(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.finalizePreparedCompletion(this.stmtId, (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}
}

class SQLiteDatabaseImpl implements SQLiteDatabase {
	constructor(private native: NSSQLiteDatabase) {}

	get isOpen(): boolean {
		return this.native.isOpen;
	}

	execute(sql: string, params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executeParamsCompletion(sql, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	select<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this.native.selectParamsCompletion(sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<T[]>(json, blobs));
				}
			});
		});
	}

	selectArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayParamsCompletion(sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult<T>(json, blobs));
				}
			});
		});
	}

	get<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): Promise<T | undefined> {
		return this.select<T>(sql, params).then((rows) => rows[0]);
	}

	getArray<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult<T>> {
		return this.selectArray<T>(sql, params).then((r) => ({ columns: r.columns, rows: r.rows.slice(0, 1) }));
	}

	async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const txId = await new Promise<number>((resolve, reject) => {
			this.native.beginTransactionCompletion('deferred', (id, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(id);
				}
			});
		});

		const tx = new WriteTxImpl(this.native, txId, { value: 0 });
		try {
			const result = await fn(tx);
			await new Promise<void>((resolve, reject) => {
				this.native.commitTransactionCompletion(txId, (error) => {
					if (error) {
						reject(toNSError(error));
					} else {
						resolve();
					}
				});
			});
			return result;
		} catch (e) {
			await new Promise<void>((resolve) => {
				this.native.rollbackTransactionCompletion(txId, () => resolve());
			});
			throw e;
		}
	}

	async readTransaction<T>(fn: (tx: ReadTransaction) => Promise<T>): Promise<T> {
		const txId = await new Promise<number>((resolve, reject) => {
			this.native.beginReadTransaction((id, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(id);
				}
			});
		});

		const tx = new ReadTxImpl(this.native, txId);
		try {
			const result = await fn(tx);
			await new Promise<void>((resolve) => {
				this.native.endReadTransactionCompletion(txId, () => resolve());
			});
			return result;
		} catch (e) {
			await new Promise<void>((resolve) => {
				this.native.endReadTransactionCompletion(txId, () => resolve());
			});
			throw e;
		}
	}

	prepare(sql: string): Promise<PreparedStatement> {
		return new Promise((resolve, reject) => {
			this.native.prepareCompletion(sql, (stmtId, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(new PreparedStatementImpl(this.native, stmtId));
				}
			});
		});
	}

	executeSync(sql: string, params?: SQLiteParams): void {
		const ok = this.native.executeSyncParamsError(sql, marshalParams(params));
		if (!ok) {
			throw new SQLiteError('executeSync failed', -1);
		}
	}

	selectSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T[] {
		const json = this.native.selectSyncParamsError(sql, marshalParams(params));
		if (!json) {
			throw new SQLiteError('selectSync failed', -1);
		}
		return JSON.parse(json);
	}

	selectArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		const json = this.native.selectArraySyncParamsError(sql, marshalParams(params));
		if (!json) {
			throw new SQLiteError('selectArraySync failed', -1);
		}
		return JSON.parse(json);
	}

	getSync<T extends SQLiteRow = SQLiteRow>(sql: string, params?: SQLiteParams): T | undefined {
		return this.selectSync<T>(sql, params)[0];
	}

	getArraySync<T extends SQLiteValue[] = SQLiteValue[]>(sql: string, params?: SQLiteParams): SQLiteArrayResult<T> {
		return this.selectArraySync<T>(sql, params);
	}

	// Low-level transaction control for driver integrations

	beginTransaction(behavior?: string): Promise<number> {
		return new Promise((resolve, reject) => {
			this.native.beginTransactionCompletion(behavior ?? 'deferred', (id, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(id);
				}
			});
		});
	}

	executeInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.executeInTransactionSqlParamsCompletion(txId, sql, marshalParams(params), (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	selectInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteRow[]> {
		return new Promise((resolve, reject) => {
			this.native.selectInTransactionSqlParamsCompletion(txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseSelectResult<SQLiteRow[]>(json, blobs));
				}
			});
		});
	}

	selectArrayInTransaction(txId: number, sql: string, params?: SQLiteParams): Promise<SQLiteArrayResult> {
		return new Promise((resolve, reject) => {
			this.native.selectArrayInTransactionSqlParamsCompletion(txId, sql, marshalParams(params), (json, blobs, error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve(parseArrayResult(json, blobs));
				}
			});
		});
	}

	commitTransaction(txId: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.native.commitTransactionCompletion(txId, (error) => {
				if (error) {
					reject(toNSError(error));
				} else {
					resolve();
				}
			});
		});
	}

	rollbackTransaction(txId: number): Promise<void> {
		return new Promise((resolve) => {
			this.native.rollbackTransactionCompletion(txId, () => resolve());
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this.native.closeWithCompletion(() => {
				resolve();
			});
		});
	}
}

export function openDatabase(options: DatabaseOptions): SQLiteDatabase {
	const native = NSSQLiteDatabase.openWithPathPoolSizeReadOnlyBusyTimeoutEncryptionKey(options.path, options.poolSize ?? 4, options.readOnly ?? false, options.busyTimeout ?? 5000, options.encryptionKey ?? null);
	if (!native) {
		throw new SQLiteError(`Failed to open database: ${options.path}`, -1);
	}
	return new SQLiteDatabaseImpl(native);
}
