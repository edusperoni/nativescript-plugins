import { DEFAULT_HEADERS } from '../lib/constants';
import { StorageError } from '../lib/common/errors';
import { Fetch, vectorsApi } from '../lib/common/fetch';
import BaseApiClient from '../lib/common/BaseApiClient';
import { ApiResponse, VectorIndex, ListIndexesOptions, ListIndexesResponse, VectorDataType, DistanceMetric, MetadataConfiguration } from '../lib/types';

export interface CreateIndexOptions {
	vectorBucketName: string;
	indexName: string;
	dataType: VectorDataType;
	dimension: number;
	distanceMetric: DistanceMetric;
	metadataConfiguration?: MetadataConfiguration;
}

export default class VectorIndexApi extends BaseApiClient<StorageError> {
	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch) {
		const finalUrl = url.replace(/\/$/, '');
		const finalHeaders = { ...DEFAULT_HEADERS, 'Content-Type': 'application/json', ...headers };
		super(finalUrl, finalHeaders, fetch, 'vectors');
	}

	async createIndex(options: CreateIndexOptions): Promise<ApiResponse<undefined>> {
		return this.handleOperation(async () => {
			const data = await vectorsApi.post(this.fetch, `${this.url}/CreateIndex`, options, {
				headers: this.headers,
			});
			return data || {};
		});
	}

	async getIndex(vectorBucketName: string, indexName: string): Promise<ApiResponse<{ index: VectorIndex }>> {
		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/GetIndex`, { vectorBucketName, indexName }, { headers: this.headers });
		});
	}

	async listIndexes(options: ListIndexesOptions): Promise<ApiResponse<ListIndexesResponse>> {
		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/ListIndexes`, options, {
				headers: this.headers,
			});
		});
	}

	async deleteIndex(vectorBucketName: string, indexName: string): Promise<ApiResponse<undefined>> {
		return this.handleOperation(async () => {
			const data = await vectorsApi.post(this.fetch, `${this.url}/DeleteIndex`, { vectorBucketName, indexName }, { headers: this.headers });
			return data || {};
		});
	}
}
