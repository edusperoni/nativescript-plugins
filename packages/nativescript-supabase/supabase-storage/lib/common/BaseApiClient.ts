import { ErrorNamespace, isStorageError, StorageError } from './errors';
import { Fetch } from './fetch';
import { normalizeHeaders, setHeader as setHeaderUtil } from './headers';
import { resolveFetch } from './helpers';

export default abstract class BaseApiClient<TError extends StorageError = StorageError> {
	protected url: string;
	protected headers: { [key: string]: string };
	protected fetch: Fetch;
	protected shouldThrowOnError = false;
	protected namespace: ErrorNamespace;

	constructor(url: string, headers: { [key: string]: string } = {}, fetch?: Fetch, namespace: ErrorNamespace = 'storage') {
		this.url = url;
		this.headers = normalizeHeaders(headers);
		this.fetch = resolveFetch(fetch);
		this.namespace = namespace;
	}

	public throwOnError(): this {
		this.shouldThrowOnError = true;
		return this;
	}

	public setHeader(name: string, value: string): this {
		this.headers = setHeaderUtil(this.headers, name, value);
		return this;
	}

	protected async handleOperation<T>(operation: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: TError }> {
		try {
			const data = await operation();
			return { data, error: null };
		} catch (error) {
			if (this.shouldThrowOnError) {
				throw error;
			}
			if (isStorageError(error)) {
				return { data: null, error: error as TError };
			}
			throw error;
		}
	}
}
