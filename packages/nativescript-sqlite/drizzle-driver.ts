/**
 * Drizzle ORM driver for @edusperoni/nativescript-sqlite
 *
 * Usage:
 *   import { drizzle } from '@edusperoni/nativescript-sqlite/drizzle-driver';
 *   import { openDatabase } from '@edusperoni/nativescript-sqlite';
 *
 *   const sqlite = openDatabase({ path: '...' });
 *   const db = drizzle(sqlite, { schema });
 *
 *   // Concurrent transactions are safe — each gets its own native connection context
 *   await Promise.all([
 *     db.transaction(async (tx) => { ... }),
 *     db.transaction(async (tx) => { ... }),
 *   ]);
 */

import { entityKind } from 'drizzle-orm/entity';
import { DefaultLogger, type Logger } from 'drizzle-orm/logger';
import { NoopLogger } from 'drizzle-orm/logger';
import { fillPlaceholders, type Query, sql } from 'drizzle-orm/sql/sql';
import { type RelationalSchemaConfig, type TablesRelationalConfig, createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import { SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import { type PreparedQueryConfig, type SQLiteExecuteMethod, type SQLiteTransactionConfig, SQLitePreparedQuery, SQLiteSession } from 'drizzle-orm/sqlite-core/session';
import type { SelectedFieldsOrdered } from 'drizzle-orm/sqlite-core/query-builders/select.types';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { Cache } from 'drizzle-orm/cache/core/cache';
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import { NoopCache } from 'drizzle-orm/cache/core';

// @ts-expect-error — mapResultRow is not exported in drizzle-orm's .d.ts but exists at runtime (used by all built-in drivers)
import { mapResultRow } from 'drizzle-orm/utils';

export interface NSSQLiteDriverDatabase {
	execute(sql: string, params?: any[]): Promise<void>;
	select(sql: string, params?: any[]): Promise<Record<string, any>[]>;
	selectArray(sql: string, params?: any[]): Promise<{ columns: string[]; rows: any[][] }>;

	beginTransaction(): Promise<number>;
	executeInTransaction(txId: number, sql: string, params?: any[]): Promise<void>;
	selectInTransaction(txId: number, sql: string, params?: any[]): Promise<Record<string, any>[]>;
	selectArrayInTransaction(txId: number, sql: string, params?: any[]): Promise<{ columns: string[]; rows: any[][] }>;
	commitTransaction(txId: number): Promise<void>;
	rollbackTransaction(txId: number): Promise<void>;
}

export interface NSSQLiteResult<T = unknown> {
	rows?: T[];
}

// MARK: - Prepared Query

class NSSQLitePreparedQuery<T extends PreparedQueryConfig = PreparedQueryConfig> extends SQLitePreparedQuery<{
	type: 'async';
	run: NSSQLiteResult;
	all: T['all'];
	get: T['get'];
	values: T['values'];
	execute: T['execute'];
}> {
	static override readonly [entityKind] = 'NSSQLitePreparedQuery';
	private method: SQLiteExecuteMethod;

	constructor(
		private client: NSSQLiteDriverDatabase,
		private txId: number | null,
		query: Query,
		private logger: Logger,
		cache: Cache,
		queryMetadata: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] } | undefined,
		cacheConfig: WithCacheConfig | undefined,
		private fields: SelectedFieldsOrdered | undefined,
		executeMethod: SQLiteExecuteMethod,
		private _isResponseInArrayMode: boolean,
		private customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
	) {
		super('async', executeMethod, query, cache, queryMetadata, cacheConfig);
		this.method = executeMethod;
	}

	private get _queryWithCache(): (sql: string, params: unknown[], fn: () => Promise<any>) => Promise<any> {
		return (this as any).queryWithCache.bind(this);
	}

	private get _joinsNotNullableMap(): any {
		return (this as any).joinsNotNullableMap;
	}

	override getQuery(): Query & { method: SQLiteExecuteMethod } {
		return { ...this.query, method: this.method };
	}

	async run(placeholderValues?: Record<string, unknown>): Promise<NSSQLiteResult> {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return await this._queryWithCache(this.query.sql, params, async () => {
			if (this.txId !== null) {
				await this.client.executeInTransaction(this.txId, this.query.sql, params as any[]);
			} else {
				await this.client.execute(this.query.sql, params as any[]);
			}
			return {} as NSSQLiteResult;
		});
	}

	override mapAllResult(rows: unknown, isFromBatch?: boolean): unknown {
		if (isFromBatch) {
			rows = (rows as any).rows;
		}
		if (!this.fields && !this.customResultMapper) {
			return rows;
		}
		if (this.customResultMapper) {
			return this.customResultMapper(rows as unknown[][]);
		}
		return (rows as unknown[]).map((row) => {
			return mapResultRow(this.fields!, row, this._joinsNotNullableMap);
		});
	}

	async all(placeholderValues?: Record<string, unknown>): Promise<T['all']> {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const { rows } = await this._queryWithCache(this.query.sql, params, async () => {
			let resultRows: any[];
			if (this._isResponseInArrayMode) {
				const result = this.txId !== null ? await this.client.selectArrayInTransaction(this.txId, this.query.sql, params as any[]) : await this.client.selectArray(this.query.sql, params as any[]);
				resultRows = result.rows;
			} else {
				resultRows = this.txId !== null ? await this.client.selectInTransaction(this.txId, this.query.sql, params as any[]) : await this.client.select(this.query.sql, params as any[]);
			}
			return { rows: resultRows };
		});
		return this.mapAllResult(rows);
	}

	async get(placeholderValues?: Record<string, unknown>): Promise<T['get']> {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const clientResult = await this._queryWithCache(this.query.sql, params, async () => {
			let resultRows: any[];
			if (this._isResponseInArrayMode) {
				const result = this.txId !== null ? await this.client.selectArrayInTransaction(this.txId, this.query.sql, params as any[]) : await this.client.selectArray(this.query.sql, params as any[]);
				resultRows = result.rows;
			} else {
				resultRows = this.txId !== null ? await this.client.selectInTransaction(this.txId, this.query.sql, params as any[]) : await this.client.select(this.query.sql, params as any[]);
			}
			return { rows: resultRows[0] };
		});
		return this.mapGetResult(clientResult.rows);
	}

	override mapGetResult(rows: unknown, isFromBatch?: boolean): unknown {
		if (isFromBatch) {
			rows = (rows as any).rows;
		}
		const row = rows;
		if (!this.fields && !this.customResultMapper) {
			return row;
		}
		if (!row) {
			return undefined;
		}
		if (this.customResultMapper) {
			return this.customResultMapper([rows] as unknown[][]);
		}
		return mapResultRow(this.fields!, row, this._joinsNotNullableMap);
	}

	async values<V extends any[] = unknown[]>(placeholderValues?: Record<string, unknown>): Promise<V[]> {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const clientResult = await this._queryWithCache(this.query.sql, params, async () => {
			const result = this.txId !== null ? await this.client.selectArrayInTransaction(this.txId, this.query.sql, params as any[]) : await this.client.selectArray(this.query.sql, params as any[]);
			return { rows: result.rows };
		});
		return clientResult.rows as V[];
	}

	/** @internal */
	isResponseInArrayMode(): boolean {
		return this._isResponseInArrayMode;
	}
}

// MARK: - Session (pool-routed, no transaction)

class NSSQLiteSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig> extends SQLiteSession<'async', NSSQLiteResult, TFullSchema, TSchema> {
	static override readonly [entityKind] = 'NSSQLiteSession';
	private logger: Logger;
	private cache: Cache;

	constructor(
		protected client: NSSQLiteDriverDatabase,
		dialect: SQLiteAsyncDialect,
		protected schema: RelationalSchemaConfig<TSchema> | undefined,
		options: { logger?: Logger; cache?: Cache } = {},
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.cache = options.cache ?? new NoopCache();
	}

	private get _dialect(): SQLiteAsyncDialect {
		return (this as any).dialect;
	}

	prepareQuery(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, isResponseInArrayMode: boolean, customResultMapper?: (rows: unknown[][]) => unknown, queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }, cacheConfig?: WithCacheConfig): NSSQLitePreparedQuery {
		return new NSSQLitePreparedQuery(this.client, null, query, this.logger, this.cache, queryMetadata, cacheConfig, fields, executeMethod, isResponseInArrayMode, customResultMapper);
	}

	async transaction<T>(transaction: (tx: SQLiteTransaction<'async', NSSQLiteResult, TFullSchema, TSchema>) => Promise<T>, config?: SQLiteTransactionConfig): Promise<T> {
		const txId = await this.client.beginTransaction();
		const txSession = new NSSQLiteTxSession<TFullSchema, TSchema>(this.client, txId, this._dialect, this.schema, {
			logger: this.logger,
			cache: this.cache,
		});
		const tx = new NSSQLiteTransaction<TFullSchema, TSchema>('async', this._dialect, txSession, this.schema);
		try {
			const result = await transaction(tx);
			await this.client.commitTransaction(txId);
			return result;
		} catch (err) {
			await this.client.rollbackTransaction(txId);
			throw err;
		}
	}

	extractRawAllValueFromBatchResult(result: unknown): unknown {
		return (result as any).rows;
	}

	extractRawGetValueFromBatchResult(result: unknown): unknown {
		return (result as any).rows?.[0];
	}

	extractRawValuesValueFromBatchResult(result: unknown): unknown {
		return (result as any).rows;
	}
}

// MARK: - Transaction Session (scoped to a txId)

class NSSQLiteTxSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig> extends SQLiteSession<'async', NSSQLiteResult, TFullSchema, TSchema> {
	static override readonly [entityKind] = 'NSSQLiteTxSession';
	private logger: Logger;
	private cache: Cache;

	constructor(
		private client: NSSQLiteDriverDatabase,
		private txId: number,
		dialect: SQLiteAsyncDialect,
		private schema: RelationalSchemaConfig<TSchema> | undefined,
		options: { logger?: Logger; cache?: Cache } = {},
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.cache = options.cache ?? new NoopCache();
	}

	prepareQuery(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, isResponseInArrayMode: boolean, customResultMapper?: (rows: unknown[][]) => unknown, queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }, cacheConfig?: WithCacheConfig): NSSQLitePreparedQuery {
		return new NSSQLitePreparedQuery(this.client, this.txId, query, this.logger, this.cache, queryMetadata, cacheConfig, fields, executeMethod, isResponseInArrayMode, customResultMapper);
	}

	async transaction<T>(_transaction: (tx: SQLiteTransaction<'async', NSSQLiteResult, TFullSchema, TSchema>) => Promise<T>, _config?: SQLiteTransactionConfig): Promise<T> {
		throw new Error('Nested transactions must use savepoints via tx.transaction()');
	}

	extractRawAllValueFromBatchResult(result: unknown): unknown {
		return (result as any).rows;
	}

	extractRawGetValueFromBatchResult(result: unknown): unknown {
		return (result as any).rows?.[0];
	}

	extractRawValuesValueFromBatchResult(result: unknown): unknown {
		return (result as any).rows;
	}
}

// MARK: - Transaction

class NSSQLiteTransaction<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig> extends SQLiteTransaction<'async', NSSQLiteResult, TFullSchema, TSchema> {
	static override readonly [entityKind] = 'NSSQLiteTransaction';

	private get _dialect(): SQLiteAsyncDialect {
		return (this as any).dialect;
	}

	private get _session(): SQLiteSession<'async', NSSQLiteResult, TFullSchema, TSchema> {
		return (this as any).session;
	}

	async transaction<T>(transaction: (tx: SQLiteTransaction<'async', NSSQLiteResult, TFullSchema, TSchema>) => Promise<T>): Promise<T> {
		const savepointName = `sp${this.nestedIndex}`;
		const tx = new NSSQLiteTransaction<TFullSchema, TSchema>('async', this._dialect, this._session, this.schema, this.nestedIndex + 1);
		await this._session.run(sql.raw(`savepoint ${savepointName}`));
		try {
			const result = await transaction(tx);
			await this._session.run(sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			await this._session.run(sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
}

// MARK: - Database

export class NSSQLiteDrizzleDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends BaseSQLiteDatabase<'async', NSSQLiteResult, TSchema> {
	static override readonly [entityKind] = 'NSSQLiteDrizzleDatabase';
}

// MARK: - drizzle() factory

export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(client: NSSQLiteDriverDatabase, config?: DrizzleConfig<TSchema>): NSSQLiteDrizzleDatabase<TSchema> {
	const dialect = new SQLiteAsyncDialect({ casing: config?.casing });
	let logger: Logger | undefined;
	const cache: Cache | undefined = config?.cache;

	if (config?.logger === true) {
		logger = new DefaultLogger();
	} else if (config?.logger !== false) {
		logger = config?.logger;
	}

	let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
	if (config?.schema) {
		const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap,
		};
	}

	const session = new NSSQLiteSession(client, dialect, schema as any, { logger, cache });
	const db = new NSSQLiteDrizzleDatabase('async', dialect, session, schema as any);
	return db as NSSQLiteDrizzleDatabase<TSchema>;
}
