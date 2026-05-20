import StorageFileApi from './packages/StorageFileApi';
import StorageBucketApi from './packages/StorageBucketApi';
import StorageAnalyticsClient from './packages/StorageAnalyticsClient';
import { Fetch } from './lib/common/fetch';
import { StorageVectorsClient } from './packages/StorageVectorsClient';

export interface StorageClientOptions {
	useNewHostname?: boolean;
}

export class StorageClient extends StorageBucketApi {
	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch, opts?: StorageClientOptions) {
		super(url, headers, fetch, opts);
	}

	from(id: string): StorageFileApi {
		return new StorageFileApi(this.url, this.headers, id, this.fetch);
	}

	get vectors(): StorageVectorsClient {
		return new StorageVectorsClient(this.url + '/vector', {
			headers: this.headers,
			fetch: this.fetch,
		});
	}

	get analytics(): StorageAnalyticsClient {
		return new StorageAnalyticsClient(this.url + '/iceberg', this.headers, this.fetch);
	}
}
