import { StorageApiError, StorageUnknownError, ErrorNamespace } from './errors';
import { setHeader } from './headers';
import { isPlainObject } from './helpers';
import { FetchParameters } from '../types';

export type Fetch = typeof fetch;

export interface FetchOptions {
	headers?: {
		[key: string]: string;
	};
	duplex?: string;
	noResolveJson?: boolean;
}

export type RequestMethodType = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';

const _getErrorMessage = (err: unknown): string => {
	if (typeof err === 'object' && err !== null) {
		const e = err as Record<string, unknown>;
		if (typeof e.msg === 'string') return e.msg;
		if (typeof e.message === 'string') return e.message;
		if (typeof e.error_description === 'string') return e.error_description;
		if (typeof e.error === 'string') return e.error;
		if (typeof e.error === 'object' && e.error !== null) {
			const nested = e.error as Record<string, unknown>;
			if (typeof nested.message === 'string') return nested.message;
		}
	}
	return JSON.stringify(err);
};

const handleError = async (error: unknown, reject: (reason: StorageApiError | StorageUnknownError) => void, options: FetchOptions | undefined, namespace: ErrorNamespace) => {
	const isResponseLike = error !== null && typeof error === 'object' && 'json' in error && typeof (error as Record<string, unknown>).json === 'function';

	if (isResponseLike) {
		const responseError = error as Response;
		let status = parseInt(String(responseError.status), 10);
		if (!Number.isFinite(status)) {
			status = 500;
		}

		responseError
			.json()
			.then((err: { statusCode?: string; code?: string; error?: string; message?: string } | null) => {
				const statusCode = err?.statusCode || err?.code || status + '';
				reject(new StorageApiError(_getErrorMessage(err), status, statusCode, namespace));
			})
			.catch(() => {
				const statusCode = status + '';
				const message = responseError.statusText || `HTTP ${status} error`;
				reject(new StorageApiError(message, status, statusCode, namespace));
			});
	} else {
		reject(new StorageUnknownError(_getErrorMessage(error), error, namespace));
	}
};

const _getRequestParams = (method: RequestMethodType, options?: FetchOptions, parameters?: FetchParameters, body?: object) => {
	const params: { [k: string]: any } = { method, headers: options?.headers || {} };

	if (method === 'GET' || method === 'HEAD' || !body) {
		return { ...params, ...parameters };
	}

	if (isPlainObject(body)) {
		const headers = options?.headers || {};
		let contentType: string | undefined;

		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === 'content-type') {
				contentType = value;
			}
		}

		params.headers = setHeader(headers, 'Content-Type', contentType ?? 'application/json');
		params.body = JSON.stringify(body);
	} else {
		params.body = body;
	}

	if (options?.duplex) {
		params.duplex = options.duplex;
	}

	return { ...params, ...parameters };
};

async function _handleRequest(fetcher: Fetch, method: RequestMethodType, url: string, options: FetchOptions | undefined, parameters: FetchParameters | undefined, body: object | undefined, namespace: ErrorNamespace): Promise<any> {
	return new Promise((resolve, reject) => {
		fetcher(url, _getRequestParams(method, options, parameters, body))
			.then((result) => {
				if (!result.ok) throw result;
				if (options?.noResolveJson) return result;

				if (namespace === 'vectors') {
					const contentType = result.headers.get('content-type');
					const contentLength = result.headers.get('content-length');

					if (contentLength === '0' || result.status === 204) {
						return {};
					}

					if (!contentType || !contentType.includes('application/json')) {
						return {};
					}
				}

				return result.json();
			})
			.then((data) => resolve(data))
			.catch((error) => handleError(error, reject, options, namespace));
	});
}

export function createFetchApi(namespace: ErrorNamespace = 'storage') {
	return {
		get: async (fetcher: Fetch, url: string, options?: FetchOptions, parameters?: FetchParameters): Promise<any> => {
			return _handleRequest(fetcher, 'GET', url, options, parameters, undefined, namespace);
		},

		post: async (fetcher: Fetch, url: string, body: object, options?: FetchOptions, parameters?: FetchParameters): Promise<any> => {
			return _handleRequest(fetcher, 'POST', url, options, parameters, body, namespace);
		},

		put: async (fetcher: Fetch, url: string, body: object, options?: FetchOptions, parameters?: FetchParameters): Promise<any> => {
			return _handleRequest(fetcher, 'PUT', url, options, parameters, body, namespace);
		},

		head: async (fetcher: Fetch, url: string, options?: FetchOptions, parameters?: FetchParameters): Promise<any> => {
			return _handleRequest(
				fetcher,
				'HEAD',
				url,
				{
					...options,
					noResolveJson: true,
				},
				parameters,
				undefined,
				namespace,
			);
		},

		remove: async (fetcher: Fetch, url: string, body: object, options?: FetchOptions, parameters?: FetchParameters): Promise<any> => {
			return _handleRequest(fetcher, 'DELETE', url, options, parameters, body, namespace);
		},
	};
}

const defaultApi = createFetchApi('storage');
export const { get, post, put, head, remove } = defaultApi;

export const vectorsApi = createFetchApi('vectors');
