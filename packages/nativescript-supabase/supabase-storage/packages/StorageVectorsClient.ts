import VectorIndexApi, { CreateIndexOptions } from './VectorIndexApi';
import VectorDataApi from './VectorDataApi';
import { Fetch } from '../lib/common/fetch';
import VectorBucketApi from './VectorBucketApi';
import { ApiResponse, DeleteVectorsOptions, GetVectorsOptions, ListIndexesOptions, ListVectorsOptions, ListVectorBucketsOptions, ListVectorBucketsResponse, PutVectorsOptions, QueryVectorsOptions, VectorBucket } from '../lib/types';

export interface StorageVectorsClientOptions {
	headers?: { [key: string]: string };
	fetch?: Fetch;
}

export class StorageVectorsClient extends VectorBucketApi {
	constructor(url: string, options: StorageVectorsClientOptions = {}) {
		super(url, options.headers || {}, options.fetch);
	}

	from(vectorBucketName: string): VectorBucketScope {
		return new VectorBucketScope(this.url, this.headers, vectorBucketName, this.fetch);
	}

	async createBucket(vectorBucketName: string): Promise<ApiResponse<undefined>> {
		return super.createBucket(vectorBucketName);
	}

	async getBucket(vectorBucketName: string): Promise<ApiResponse<{ vectorBucket: VectorBucket }>> {
		return super.getBucket(vectorBucketName);
	}

	async listBuckets(options: ListVectorBucketsOptions = {}): Promise<ApiResponse<ListVectorBucketsResponse>> {
		return super.listBuckets(options);
	}

	async deleteBucket(vectorBucketName: string): Promise<ApiResponse<undefined>> {
		return super.deleteBucket(vectorBucketName);
	}
}

export class VectorBucketScope extends VectorIndexApi {
	private vectorBucketName: string;

	constructor(url: string, headers: { [key: string]: string }, vectorBucketName: string, fetch?: Fetch) {
		super(url, headers, fetch);
		this.vectorBucketName = vectorBucketName;
	}

	override async createIndex(options: Omit<CreateIndexOptions, 'vectorBucketName'>) {
		return super.createIndex({
			...options,
			vectorBucketName: this.vectorBucketName,
		});
	}

	override async listIndexes(options: Omit<ListIndexesOptions, 'vectorBucketName'> = {}) {
		return super.listIndexes({
			...options,
			vectorBucketName: this.vectorBucketName,
		});
	}

	override async getIndex(indexName: string) {
		return super.getIndex(this.vectorBucketName, indexName);
	}

	override async deleteIndex(indexName: string) {
		return super.deleteIndex(this.vectorBucketName, indexName);
	}

	index(indexName: string): VectorIndexScope {
		return new VectorIndexScope(this.url, this.headers, this.vectorBucketName, indexName, this.fetch);
	}
}

export class VectorIndexScope extends VectorDataApi {
	private vectorBucketName: string;
	private indexName: string;

	constructor(url: string, headers: { [key: string]: string }, vectorBucketName: string, indexName: string, fetch?: Fetch) {
		super(url, headers, fetch);
		this.vectorBucketName = vectorBucketName;
		this.indexName = indexName;
	}

	override async putVectors(options: Omit<PutVectorsOptions, 'vectorBucketName' | 'indexName'>) {
		return super.putVectors({
			...options,
			vectorBucketName: this.vectorBucketName,
			indexName: this.indexName,
		});
	}

	override async getVectors(options: Omit<GetVectorsOptions, 'vectorBucketName' | 'indexName'>) {
		return super.getVectors({
			...options,
			vectorBucketName: this.vectorBucketName,
			indexName: this.indexName,
		});
	}

	override async listVectors(options: Omit<ListVectorsOptions, 'vectorBucketName' | 'indexName'> = {}) {
		return super.listVectors({
			...options,
			vectorBucketName: this.vectorBucketName,
			indexName: this.indexName,
		});
	}

	override async queryVectors(options: Omit<QueryVectorsOptions, 'vectorBucketName' | 'indexName'>) {
		return super.queryVectors({
			...options,
			vectorBucketName: this.vectorBucketName,
			indexName: this.indexName,
		});
	}

	override async deleteVectors(options: Omit<DeleteVectorsOptions, 'vectorBucketName' | 'indexName'>) {
		return super.deleteVectors({
			...options,
			vectorBucketName: this.vectorBucketName,
			indexName: this.indexName,
		});
	}
}
