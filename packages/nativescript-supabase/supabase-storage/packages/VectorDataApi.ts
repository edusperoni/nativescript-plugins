import { DEFAULT_HEADERS } from '../lib/constants';
import { StorageError } from '../lib/common/errors';
import { Fetch, vectorsApi } from '../lib/common/fetch';
import BaseApiClient from '../lib/common/BaseApiClient';
import { ApiResponse, PutVectorsOptions, GetVectorsOptions, GetVectorsResponse, DeleteVectorsOptions, ListVectorsOptions, ListVectorsResponse, QueryVectorsOptions, QueryVectorsResponse } from '../lib/types';

export default class VectorDataApi extends BaseApiClient<StorageError> {
	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch) {
		const finalUrl = url.replace(/\/$/, '');
		const finalHeaders = { ...DEFAULT_HEADERS, 'Content-Type': 'application/json', ...headers };
		super(finalUrl, finalHeaders, fetch, 'vectors');
	}

	async putVectors(options: PutVectorsOptions): Promise<ApiResponse<undefined>> {
		if (options.vectors.length < 1 || options.vectors.length > 500) {
			throw new Error('Vector batch size must be between 1 and 500 items');
		}

		return this.handleOperation(async () => {
			const data = await vectorsApi.post(this.fetch, `${this.url}/PutVectors`, options, {
				headers: this.headers,
			});
			return data || {};
		});
	}

	async getVectors(options: GetVectorsOptions): Promise<ApiResponse<GetVectorsResponse>> {
		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/GetVectors`, options, {
				headers: this.headers,
			});
		});
	}

	async listVectors(options: ListVectorsOptions): Promise<ApiResponse<ListVectorsResponse>> {
		if (options.segmentCount !== undefined) {
			if (options.segmentCount < 1 || options.segmentCount > 16) {
				throw new Error('segmentCount must be between 1 and 16');
			}
			if (options.segmentIndex !== undefined) {
				if (options.segmentIndex < 0 || options.segmentIndex >= options.segmentCount) {
					throw new Error(`segmentIndex must be between 0 and ${options.segmentCount - 1}`);
				}
			}
		}

		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/ListVectors`, options, {
				headers: this.headers,
			});
		});
	}

	async queryVectors(options: QueryVectorsOptions): Promise<ApiResponse<QueryVectorsResponse>> {
		return this.handleOperation(async () => {
			return await vectorsApi.post(this.fetch, `${this.url}/QueryVectors`, options, {
				headers: this.headers,
			});
		});
	}

	async deleteVectors(options: DeleteVectorsOptions): Promise<ApiResponse<undefined>> {
		if (options.keys.length < 1 || options.keys.length > 500) {
			throw new Error('Keys batch size must be between 1 and 500 items');
		}

		return this.handleOperation(async () => {
			const data = await vectorsApi.post(this.fetch, `${this.url}/DeleteVectors`, options, {
				headers: this.headers,
			});
			return data || {};
		});
	}
}
