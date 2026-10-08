import { IcebergRestCatalog, IcebergError } from 'iceberg-js';
import { DEFAULT_HEADERS } from '../lib/constants';
import { StorageError } from '../lib/common/errors';
import { Fetch, get, post, remove } from '../lib/common/fetch';
import { isValidBucketName } from '../lib/common/helpers';
import BaseApiClient from '../lib/common/BaseApiClient';
import { AnalyticBucket } from '../lib/types';

type WrapAsyncMethod<T> = T extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<{ data: R; error: null } | { data: null; error: IcebergError }> : T;

export type WrappedIcebergRestCatalog = {
	[K in keyof IcebergRestCatalog]: WrapAsyncMethod<IcebergRestCatalog[K]>;
};

export default class StorageAnalyticsClient extends BaseApiClient<StorageError> {
	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch) {
		const finalUrl = url.replace(/\/$/, '');
		const finalHeaders = { ...DEFAULT_HEADERS, ...headers };
		super(finalUrl, finalHeaders, fetch, 'storage');
	}

	async createBucket(name: string): Promise<
		| {
				data: AnalyticBucket;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await post(this.fetch, `${this.url}/bucket`, { name }, { headers: this.headers });
		});
	}

	async listBuckets(options?: { limit?: number; offset?: number; sortColumn?: 'name' | 'created_at' | 'updated_at'; sortOrder?: 'asc' | 'desc'; search?: string }): Promise<
		| {
				data: AnalyticBucket[];
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const queryParams = new URLSearchParams();
			if (options?.limit !== undefined) queryParams.set('limit', options.limit.toString());
			if (options?.offset !== undefined) queryParams.set('offset', options.offset.toString());
			if (options?.sortColumn) queryParams.set('sortColumn', options.sortColumn);
			if (options?.sortOrder) queryParams.set('sortOrder', options.sortOrder);
			if (options?.search) queryParams.set('search', options.search);

			const queryString = queryParams.toString();
			const url = queryString ? `${this.url}/bucket?${queryString}` : `${this.url}/bucket`;

			return await get(this.fetch, url, { headers: this.headers });
		});
	}

	async deleteBucket(bucketName: string): Promise<
		| {
				data: { message: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await remove(this.fetch, `${this.url}/bucket/${bucketName}`, {}, { headers: this.headers });
		});
	}

	from(bucketName: string): WrappedIcebergRestCatalog {
		if (!isValidBucketName(bucketName)) {
			throw new StorageError('Invalid bucket name: File, folder, and bucket names must follow AWS object key naming guidelines ' + 'and should avoid the use of any other characters.');
		}

		const catalog = new IcebergRestCatalog({
			baseUrl: this.url,
			catalogName: bucketName,
			auth: {
				type: 'custom',
				getHeaders: async () => this.headers,
			},
			fetch: this.fetch,
		});

		const shouldThrowOnError = this.shouldThrowOnError;

		const wrappedCatalog = new Proxy(catalog, {
			get(target, prop: keyof IcebergRestCatalog) {
				const value = target[prop];
				if (typeof value !== 'function') {
					return value;
				}

				return async (...args: unknown[]) => {
					try {
						const data = await (value as Function).apply(target, args);
						return { data, error: null };
					} catch (error) {
						if (shouldThrowOnError) {
							throw error;
						}
						return { data: null, error: error as IcebergError };
					}
				};
			},
		}) as unknown as WrappedIcebergRestCatalog;

		return wrappedCatalog;
	}
}
