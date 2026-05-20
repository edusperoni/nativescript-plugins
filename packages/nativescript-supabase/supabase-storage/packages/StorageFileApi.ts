import { StorageApiError, StorageError, StorageUnknownError, isStorageError } from '../lib/common/errors';
import { get, head, post, put, remove, Fetch } from '../lib/common/fetch';
import { setHeader } from '../lib/common/headers';
import { recursiveToCamel } from '../lib/common/helpers';
import BaseApiClient from '../lib/common/BaseApiClient';
import { FileObject, FileOptions, SearchOptions, FetchParameters, TransformOptions, DestinationOptions, FileObjectV2, Camelize, SearchV2Options, SearchV2Result } from '../lib/types';
import BlobDownloadBuilder from './BlobDownloadBuilder';
import { Http, HTTPFormData, HTTPFormDataEntry } from '@klippa/nativescript-http';

const DEFAULT_SEARCH_OPTIONS = {
	limit: 100,
	offset: 0,
	sortBy: {
		column: 'name',
		order: 'asc',
	},
};

const DEFAULT_FILE_OPTIONS: FileOptions = {
	cacheControl: '3600',
	contentType: 'text/plain;charset=UTF-8',
	upsert: false,
};

type FileBody = ArrayBuffer | ArrayBufferView | Blob | Buffer | File | FormData | NodeJS.ReadableStream | ReadableStream<Uint8Array> | URLSearchParams | string;

export default class StorageFileApi extends BaseApiClient<StorageError> {
	protected bucketId: string | undefined;

	constructor(url: string, headers: { [key: string]: string } = {}, bucketId?: string, fetch?: Fetch) {
		super(url, headers, fetch, 'storage');
		this.bucketId = bucketId;
	}

	// NativeScript override: uses Http.request with HTTPFormData for native file upload support
	private async uploadOrUpdate(
		method: 'POST' | 'PUT',
		path: string,
		fileBody: FileBody,
		fileOptions?: FileOptions,
	): Promise<
		| {
				data: { id: string; path: string; fullPath: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const body = new HTTPFormData();
			const options = { ...DEFAULT_FILE_OPTIONS, ...fileOptions };
			const headers: Record<string, string> = {
				...this.headers,
				...(method === 'POST' && { 'x-upsert': String(options.upsert as boolean) }),
			};

			body.append('cacheControl', options.cacheControl as string);

			const metadata = options.metadata;
			if (metadata) {
				body.append('metadata', this.encodeMetadata(metadata));
			}

			let fileData;
			if (typeof fileBody === 'string') {
				if (global.isAndroid) {
					fileData = new HTTPFormDataEntry(new java.io.File(fileBody));
				} else if (global.isIOS) {
					fileData = new HTTPFormDataEntry(NSData.dataWithContentsOfURL(NSURL.URLWithString(fileBody)));
				}
			} else if (fileBody instanceof File) {
				fileData = new HTTPFormDataEntry(fileBody, fileBody.name, fileBody.type);
			} else {
				fileData = new HTTPFormDataEntry(fileBody);
				headers['cache-control'] = `max-age=${options.cacheControl}`;
				headers['content-type'] = options.contentType as string;
				if (metadata) {
					headers['x-metadata'] = this.toBase64(this.encodeMetadata(metadata));
				}
			}
			body.append('', fileData);

			if (fileOptions?.headers) {
				for (const [key, value] of Object.entries(fileOptions.headers)) {
					headers[key.toLowerCase()] = value;
				}
			}

			const cleanPath = this._removeEmptyFolders(path);
			const _path = this._getFinalPath(cleanPath);
			const res = await Http.request({
				method: method,
				url: `${this.url}/object/${_path}`,
				content: body,
				headers: { ...headers },
			});

			if (res.statusCode >= 200 && res.statusCode <= 299) {
				const data = res.content?.toJSON?.() as any;
				return { path: cleanPath, id: data?.Id ?? '', fullPath: data?.Key ?? `${this.bucketId}/${cleanPath}` };
			} else {
				const err = res.content?.toJSON?.() as any;
				throw new StorageApiError(err?.message || err?.error || `Upload failed with status ${res.statusCode}`, res.statusCode, String(err?.statusCode || res.statusCode));
			}
		});
	}

	async upload(
		path: string,
		fileBody: FileBody,
		fileOptions?: FileOptions,
	): Promise<
		| {
				data: { id: string; path: string; fullPath: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.uploadOrUpdate('POST', path, fileBody, fileOptions);
	}

	// NativeScript override: uses Http.request with HTTPFormData for native file upload support
	async uploadToSignedUrl(path: string, token: string, fileBody: FileBody, fileOptions?: FileOptions) {
		const cleanPath = this._removeEmptyFolders(path);
		const _path = this._getFinalPath(cleanPath);

		const url = new URL(this.url + `/object/upload/sign/${_path}`);
		url.searchParams.set('token', token);

		return this.handleOperation(async () => {
			const body = new HTTPFormData();
			const options = { ...DEFAULT_FILE_OPTIONS, ...fileOptions };
			const headers: Record<string, string> = {
				...this.headers,
				...{ 'x-upsert': String(options.upsert as boolean) },
			};

			body.append('cacheControl', options.cacheControl as string);

			const metadata = options.metadata;
			if (metadata) {
				body.append('metadata', this.encodeMetadata(metadata));
			}

			let fileData;
			if (typeof fileBody === 'string') {
				if (global.isAndroid) {
					fileData = new HTTPFormDataEntry(new java.io.File(fileBody));
				} else if (global.isIOS) {
					fileData = new HTTPFormDataEntry(NSData.dataWithContentsOfURL(NSURL.URLWithString(fileBody)));
				}
			} else if (fileBody instanceof File) {
				fileData = new HTTPFormDataEntry(fileBody, fileBody.name, fileBody.type);
			} else {
				fileData = new HTTPFormDataEntry(fileBody);
				headers['cache-control'] = `max-age=${options.cacheControl}`;
				headers['content-type'] = options.contentType as string;
				if (metadata) {
					headers['x-metadata'] = this.toBase64(this.encodeMetadata(metadata));
				}
			}
			body.append('', fileData);

			if (fileOptions?.headers) {
				for (const [key, value] of Object.entries(fileOptions.headers)) {
					headers[key.toLowerCase()] = value;
				}
			}

			const res = await Http.request({
				method: 'PUT',
				url: url.toString(),
				content: body,
				headers: { ...headers },
			});

			if (res.statusCode >= 200 && res.statusCode <= 299) {
				const data = res.content?.toJSON?.() as any;
				return { path: cleanPath, fullPath: data?.Key ?? `${this.bucketId}/${cleanPath}` };
			} else {
				const err = res.content?.toJSON?.() as any;
				throw new StorageApiError(err?.message || err?.error || `Upload failed with status ${res.statusCode}`, res.statusCode, String(err?.statusCode || res.statusCode));
			}
		});
	}

	async createSignedUploadUrl(
		path: string,
		options?: { upsert: boolean },
	): Promise<
		| {
				data: { signedUrl: string; token: string; path: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			let _path = this._getFinalPath(path);

			const headers = { ...this.headers };

			if (options?.upsert) {
				headers['x-upsert'] = 'true';
			}

			const data = await post(this.fetch, `${this.url}/object/upload/sign/${_path}`, {}, { headers });

			const url = new URL(this.url + data.url);

			const token = url.searchParams.get('token');

			if (!token) {
				throw new StorageError('No token returned by API');
			}

			return { signedUrl: url.toString(), path, token };
		});
	}

	async update(
		path: string,
		fileBody: FileBody,
		fileOptions?: FileOptions,
	): Promise<
		| {
				data: { id: string; path: string; fullPath: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.uploadOrUpdate('PUT', path, fileBody, fileOptions);
	}

	async move(
		fromPath: string,
		toPath: string,
		options?: DestinationOptions,
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
			return await post(
				this.fetch,
				`${this.url}/object/move`,
				{
					bucketId: this.bucketId,
					sourceKey: fromPath,
					destinationKey: toPath,
					destinationBucket: options?.destinationBucket,
				},
				{ headers: this.headers },
			);
		});
	}

	async copy(
		fromPath: string,
		toPath: string,
		options?: DestinationOptions,
	): Promise<
		| {
				data: { path: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const data = await post(
				this.fetch,
				`${this.url}/object/copy`,
				{
					bucketId: this.bucketId,
					sourceKey: fromPath,
					destinationKey: toPath,
					destinationBucket: options?.destinationBucket,
				},
				{ headers: this.headers },
			);
			return { path: data.Key };
		});
	}

	async createSignedUrl(
		path: string,
		expiresIn: number,
		options?: {
			download?: string | boolean;
			transform?: TransformOptions;
			cacheNonce?: string;
		},
	): Promise<
		| {
				data: { signedUrl: string };
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			let _path = this._getFinalPath(path);

			const hasTransform = typeof options?.transform === 'object' && options.transform !== null && Object.keys(options.transform).length > 0;

			let data = await post(this.fetch, `${this.url}/object/sign/${_path}`, { expiresIn, ...(hasTransform ? { transform: options!.transform } : {}) }, { headers: this.headers });

			const query = new URLSearchParams();
			if (options?.download) query.set('download', options.download === true ? '' : options.download);
			if (options?.cacheNonce != null) query.set('cacheNonce', String(options.cacheNonce));
			const queryString = query.toString();

			const signedUrl = encodeURI(`${this.url}${data.signedURL}${queryString ? `&${queryString}` : ''}`);

			return { signedUrl };
		});
	}

	async createSignedUrls(
		paths: string[],
		expiresIn: number,
		options?: { download?: string | boolean; cacheNonce?: string },
	): Promise<
		| {
				data: { error: string | null; path: string | null; signedUrl: string | null }[];
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const data = await post(this.fetch, `${this.url}/object/sign/${this.bucketId}`, { expiresIn, paths }, { headers: this.headers });

			const query = new URLSearchParams();

			if (options?.download) query.set('download', options.download === true ? '' : options.download);
			if (options?.cacheNonce != null) query.set('cacheNonce', String(options.cacheNonce));

			const queryString = query.toString();

			return data.map((datum: { signedURL: string }) => ({
				...datum,
				signedUrl: datum.signedURL ? encodeURI(`${this.url}${datum.signedURL}${queryString ? `&${queryString}` : ''}`) : null,
			}));
		});
	}

	download<Options extends { transform?: TransformOptions; cacheNonce?: string }>(path: string, options?: Options, parameters?: FetchParameters): BlobDownloadBuilder {
		const wantsTransformation = typeof options?.transform === 'object' && options.transform !== null && Object.keys(options.transform).length > 0;
		const renderPath = wantsTransformation ? 'render/image/authenticated' : 'object';

		const query = new URLSearchParams();
		if (options?.transform) this.applyTransformOptsToQuery(query, options.transform);
		if (options?.cacheNonce != null) query.set('cacheNonce', String(options.cacheNonce));
		const queryString = query.toString();

		const _path = this._getFinalPath(path);
		const downloadFn = () =>
			get(
				this.fetch,
				`${this.url}/${renderPath}/${_path}${queryString ? `?${queryString}` : ''}`,
				{
					headers: this.headers,
					noResolveJson: true,
				},
				parameters,
			);
		return new BlobDownloadBuilder(downloadFn, this.shouldThrowOnError);
	}

	async info(path: string): Promise<
		| {
				data: Camelize<FileObjectV2>;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		const _path = this._getFinalPath(path);

		return this.handleOperation(async () => {
			const data = await get(this.fetch, `${this.url}/object/info/${_path}`, {
				headers: this.headers,
			});

			return recursiveToCamel(data) as Camelize<FileObjectV2>;
		});
	}

	async exists(path: string): Promise<
		| {
				data: boolean;
				error: null;
		  }
		| {
				data: boolean;
				error: StorageError;
		  }
	> {
		const _path = this._getFinalPath(path);

		try {
			await head(this.fetch, `${this.url}/object/${_path}`, {
				headers: this.headers,
			});

			return { data: true, error: null };
		} catch (error) {
			if (this.shouldThrowOnError) {
				throw error;
			}
			if (isStorageError(error)) {
				const status = error instanceof StorageApiError ? error.status : error instanceof StorageUnknownError ? (error.originalError as { status: number })?.status : undefined;

				if (status !== undefined && [400, 404].includes(status)) {
					return { data: false, error };
				}
			}

			throw error;
		}
	}

	getPublicUrl(
		path: string,
		options?: {
			download?: string | boolean;
			transform?: TransformOptions;
			cacheNonce?: string;
		},
	): { data: { publicUrl: string } } {
		const _path = this._getFinalPath(path);

		const query = new URLSearchParams();
		if (options?.download) query.set('download', options.download === true ? '' : options.download);
		if (options?.transform) this.applyTransformOptsToQuery(query, options.transform);
		if (options?.cacheNonce != null) query.set('cacheNonce', String(options.cacheNonce));
		const queryString = query.toString();

		const wantsTransformation = typeof options?.transform === 'object' && options.transform !== null && Object.keys(options.transform).length > 0;
		const renderPath = wantsTransformation ? 'render/image' : 'object';

		return {
			data: {
				publicUrl: encodeURI(`${this.url}/${renderPath}/public/${_path}`) + (queryString ? `?${queryString}` : ''),
			},
		};
	}

	async remove(paths: string[]): Promise<
		| {
				data: FileObject[];
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			return await remove(this.fetch, `${this.url}/object/${this.bucketId}`, { prefixes: paths }, { headers: this.headers });
		});
	}

	async list(
		path?: string,
		options?: SearchOptions,
		parameters?: FetchParameters,
	): Promise<
		| {
				data: FileObject[];
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const body = { ...DEFAULT_SEARCH_OPTIONS, ...options, prefix: path || '' };
			return await post(this.fetch, `${this.url}/object/list/${this.bucketId}`, body, { headers: this.headers }, parameters);
		});
	}

	async listV2(
		options?: SearchV2Options,
		parameters?: FetchParameters,
	): Promise<
		| {
				data: SearchV2Result;
				error: null;
		  }
		| {
				data: null;
				error: StorageError;
		  }
	> {
		return this.handleOperation(async () => {
			const body = { ...options };
			return await post(this.fetch, `${this.url}/object/list-v2/${this.bucketId}`, body, { headers: this.headers }, parameters);
		});
	}

	protected encodeMetadata(metadata: Record<string, any>) {
		return JSON.stringify(metadata);
	}

	toBase64(data: string) {
		if (typeof Buffer !== 'undefined') {
			return Buffer.from(data).toString('base64');
		}
		return btoa(data);
	}

	private _getFinalPath(path: string) {
		return `${this.bucketId}/${path.replace(/^\/+/, '')}`;
	}

	private _removeEmptyFolders(path: string) {
		return path.replace(/^\/|\/$/g, '').replace(/\/+/g, '/');
	}

	private applyTransformOptsToQuery(query: URLSearchParams, transform: TransformOptions): URLSearchParams {
		if (transform.width) query.set('width', transform.width.toString());
		if (transform.height) query.set('height', transform.height.toString());
		if (transform.resize) query.set('resize', transform.resize);
		if (transform.format) query.set('format', transform.format);
		if (transform.quality) query.set('quality', transform.quality.toString());

		return query;
	}
}
