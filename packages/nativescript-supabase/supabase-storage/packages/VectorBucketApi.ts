import { DEFAULT_HEADERS } from '../lib/constants';
import { StorageError } from '../lib/common/errors';
import { Fetch, vectorsApi } from '../lib/common/fetch';
import BaseApiClient from '../lib/common/BaseApiClient';
import { ApiResponse, VectorBucket, ListVectorBucketsOptions, ListVectorBucketsResponse } from '../lib/types';

export default class VectorBucketApi extends BaseApiClient<StorageError> {
	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch) {
		const finalUrl = url.replace(/\/$/, '');
		const finalHeaders = { ...DEFAULT_HEADERS, 'Content-Type': 'application/json', ...headers };
		super(finalUrl, finalHeaders, fetch, 'vectors');
	}

	async createBucket(vectorBucketName: string): Promise<ApiResponse<undefined>> {
		return this.handleOperation(async () => {
			const data = await vectorsApi.post(this.fetch, `${this.url}/CreateVectorBucket`, { vectorBucketName }, { headers: this.headers });
			return data || {};
		});
	}

	async getBucket(vectorBucketName: string): Promise<ApiResponse<{ vectorBucket: VectorBucket }>> {
		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/GetVectorBucket`, { vectorBucketName }, { headers: this.headers });
		});
	}

	async listBuckets(options: ListVectorBucketsOptions = {}): Promise<ApiResponse<ListVectorBucketsResponse>> {
		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/ListVectorBuckets`, options, {
				headers: this.headers,
			});
		});
	}

	async deleteBucket(vectorBucketName: string): Promise<ApiResponse<undefined>> {
		return this.handleOperation(async () => {
			const data = await vectorsApi.post(this.fetch, `${this.url}/DeleteVectorBucket`, { vectorBucketName }, { headers: this.headers });
			return data || {};
		});
	}
}
