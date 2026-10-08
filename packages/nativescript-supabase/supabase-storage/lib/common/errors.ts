export type ErrorNamespace = 'storage' | 'vectors';

export class StorageError extends Error {
	protected __isStorageError = true;
	protected namespace: ErrorNamespace;
	status: number | undefined;
	statusCode: string | undefined;

	constructor(message: string, namespace: ErrorNamespace = 'storage', status?: number, statusCode?: string) {
		super(message);
		this.namespace = namespace;
		this.name = namespace === 'vectors' ? 'StorageVectorsError' : 'StorageError';
		this.status = status;
		this.statusCode = statusCode;
	}

	toJSON(): {
		name: string;
		message: string;
		status: number | undefined;
		statusCode: string | undefined;
	} {
		return {
			name: this.name,
			message: this.message,
			status: this.status,
			statusCode: this.statusCode,
		};
	}
}

export function isStorageError(error: unknown): error is StorageError {
	return typeof error === 'object' && error !== null && '__isStorageError' in error;
}

export class StorageApiError extends StorageError {
	override status: number;
	override statusCode: string;

	constructor(message: string, status: number, statusCode: string, namespace: ErrorNamespace = 'storage') {
		super(message, namespace, status, statusCode);
		this.name = namespace === 'vectors' ? 'StorageVectorsApiError' : 'StorageApiError';
		this.status = status;
		this.statusCode = statusCode;
	}

	toJSON(): {
		name: string;
		message: string;
		status: number | undefined;
		statusCode: string | undefined;
	} {
		return {
			...super.toJSON(),
		};
	}
}

export class StorageUnknownError extends StorageError {
	originalError: unknown;

	constructor(message: string, originalError: unknown, namespace: ErrorNamespace = 'storage') {
		super(message, namespace);
		this.name = namespace === 'vectors' ? 'StorageVectorsUnknownError' : 'StorageUnknownError';
		this.originalError = originalError;
	}
}

/** @deprecated Use StorageError with namespace='vectors' instead */
export class StorageVectorsError extends StorageError {
	constructor(message: string) {
		super(message, 'vectors');
	}
}

export function isStorageVectorsError(error: unknown): error is StorageVectorsError {
	return isStorageError(error) && (error as StorageError)['namespace'] === 'vectors';
}

/** @deprecated Use StorageApiError with namespace='vectors' instead */
export class StorageVectorsApiError extends StorageApiError {
	constructor(message: string, status: number, statusCode: string) {
		super(message, status, statusCode, 'vectors');
	}
}

/** @deprecated Use StorageUnknownError with namespace='vectors' instead */
export class StorageVectorsUnknownError extends StorageUnknownError {
	constructor(message: string, originalError: unknown) {
		super(message, originalError, 'vectors');
	}
}

export enum StorageVectorsErrorCode {
	InternalError = 'InternalError',
	S3VectorConflictException = 'S3VectorConflictException',
	S3VectorNotFoundException = 'S3VectorNotFoundException',
	S3VectorBucketNotEmpty = 'S3VectorBucketNotEmpty',
	S3VectorMaxBucketsExceeded = 'S3VectorMaxBucketsExceeded',
	S3VectorMaxIndexesExceeded = 'S3VectorMaxIndexesExceeded',
}
