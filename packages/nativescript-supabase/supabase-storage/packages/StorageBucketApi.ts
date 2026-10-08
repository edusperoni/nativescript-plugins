import { DEFAULT_HEADERS } from '../lib/constants';
import { StorageError } from '../lib/common/errors';
import { Fetch, get, post, put, remove } from '../lib/common/fetch';
import BaseApiClient from '../lib/common/BaseApiClient';
import { Bucket, BucketType, ListBucketOptions } from '../lib/types';
import { StorageClientOptions } from '../StorageClient';

export default class StorageBucketApi extends BaseApiClient<StorageError> {
	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch, opts?: StorageClientOptions) {
		const baseUrl = new URL(url);

		if (opts?.useNewHostname) {
			const isSupabaseHost = /supabase\.(co|in|red)$/.test(baseUrl.hostname);
			if (isSupabaseHost && !baseUrl.hostname.includes('storage.supabase.')) {
				baseUrl.hostname = baseUrl.hostname.replace('supabase.', 'storage.supabase.');
			}
		}

		const finalUrl = baseUrl.href.replace(/\/$/, '');
		const finalHeaders = { ...DEFAULT_HEADERS, ...headers };

		super(finalUrl, finalHeaders, fetch, 'storage');
	}

	async listBuckets(options?: ListBucketOptions): Promise<
		| {
				data: Bucket[];
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const queryString = this.listBucketOptionsToQueryString(options);
			return await get(this.fetch, `${this.url}/bucket${queryString}`, {
				headers: this.headers,
			});
		});
	}

	async getBucket(id: string): Promise<
		| {
				data: Bucket;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await get(this.fetch, `${this.url}/bucket/${id}`, { headers: this.headers });
		});
	}

	async createBucket(
		id: string,
		options: {
			public: boolean;
			fileSizeLimit?: number | string | null;
			allowedMimeTypes?: string[] | null;
			type?: BucketType;
		} = {
			public: false,
		},
	): Promise<
		| {
				data: Pick<Bucket, 'name'>;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await post(
				this.fetch,
				`${this.url}/bucket`,
				{
					id,
					name: id,
					type: options.type,
					public: options.public,
					file_size_limit: options.fileSizeLimit,
					allowed_mime_types: options.allowedMimeTypes,
				},
				{ headers: this.headers },
			);
		});
	}

	async updateBucket(
		id: string,
		options: {
			public: boolean;
			fileSizeLimit?: number | string | null;
			allowedMimeTypes?: string[] | null;
		},
	): Promise<
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
			return await put(
				this.fetch,
				`${this.url}/bucket/${id}`,
				{
					id,
					name: id,
					public: options.public,
					file_size_limit: options.fileSizeLimit,
					allowed_mime_types: options.allowedMimeTypes,
				},
				{ headers: this.headers },
			);
		});
	}

	async emptyBucket(id: string): Promise<
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
			return await post(this.fetch, `${this.url}/bucket/${id}/empty`, {}, { headers: this.headers });
		});
	}

	async deleteBucket(id: string): Promise<
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
			return await remove(this.fetch, `${this.url}/bucket/${id}`, {}, { headers: this.headers });
		});
	}

	private listBucketOptionsToQueryString(options?: ListBucketOptions): string {
		const params: Record<string, string> = {};
		if (options) {
			if ('limit' in options) {
				params.limit = String(options.limit);
			}
			if ('offset' in options) {
				params.offset = String(options.offset);
			}
			if (options.search) {
				params.search = options.search;
			}
			if (options.sortColumn) {
				params.sortColumn = options.sortColumn;
			}
			if (options.sortOrder) {
				params.sortOrder = options.sortOrder;
			}
		}
		return Object.keys(params).length > 0 ? '?' + new URLSearchParams(params).toString() : '';
	}
}
