import { DEFAULT_HEADERS } from '../lib/constants';
import { StorageError } from '../lib/common/errors';
import { Fetch, get, post, put, remove } from '../lib/common/fetch';
import { encodeStoragePath } from '../lib/common/helpers';
import BaseApiClient from '../lib/common/BaseApiClient';
import { Bucket, BucketLifecycleConfiguration, BucketType, CreateSettableVersioningStatus, FetchParameters, ListBucketOptions, PurgeCacheOptions, UpdateSettableVersioningStatus } from '../lib/types';
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
			versioningStatus?: CreateSettableVersioningStatus;
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
					versioning_status: options.versioningStatus,
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
			versioningStatus?: UpdateSettableVersioningStatus;
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
					versioning_status: options.versioningStatus,
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

	async getBucketLifecycle(id: string): Promise<
		| {
				data: BucketLifecycleConfiguration;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await get(this.fetch, this.bucketLifecycleUrl(id), { headers: this.headers });
		});
	}

	async updateBucketLifecycle(
		id: string,
		configuration: BucketLifecycleConfiguration,
	): Promise<
		| {
				data: BucketLifecycleConfiguration;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await put(this.fetch, this.bucketLifecycleUrl(id), configuration, {
				headers: this.headers,
			});
		});
	}

	async deleteBucketLifecycle(id: string): Promise<
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
			return await remove(this.fetch, this.bucketLifecycleUrl(id), {}, { headers: this.headers });
		});
	}

	/** Requires the `service_role` key. */
	async purgeBucketCache(
		id: string,
		options?: PurgeCacheOptions,
		parameters?: FetchParameters,
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
			const query = new URLSearchParams();
			if (options?.transformations) {
				query.set('transformations', 'true');
			}
			const queryString = query.toString();

			return await remove(this.fetch, `${this.url}/cdn/${encodeStoragePath(id)}${queryString ? `?${queryString}` : ''}`, {}, { headers: this.headers }, parameters);
		});
	}

	private bucketLifecycleUrl(id: string): string {
		return `${this.url}/bucket/${encodeStoragePath(id)}/lifecycle`;
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
