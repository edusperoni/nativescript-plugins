type Fetch = typeof fetch;

export const resolveFetch = (customFetch?: Fetch): Fetch => {
	if (customFetch) {
		// @ts-ignore
		return (...args) => customFetch(...args);
	}
	// @ts-ignore
	return (...args) => fetch(...args);
};

export const resolveResponse = (): typeof Response => {
	return Response;
};

export const isPlainObject = (value: object): boolean => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);
};

export const recursiveToCamel = (item: Record<string, any>): unknown => {
	if (Array.isArray(item)) {
		return item.map((el) => recursiveToCamel(el));
	} else if (typeof item === 'function' || item !== Object(item)) {
		return item;
	}

	const result: Record<string, any> = {};
	Object.entries(item).forEach(([key, value]) => {
		const newKey = key.replace(/([-_][a-z])/gi, (c) => c.toUpperCase().replace(/[-_]/g, ''));
		result[newKey] = recursiveToCamel(value);
	});

	return result;
};

export const isValidBucketName = (bucketName: string): boolean => {
	if (!bucketName || typeof bucketName !== 'string') {
		return false;
	}

	if (bucketName.length === 0 || bucketName.length > 100) {
		return false;
	}

	if (bucketName.trim() !== bucketName) {
		return false;
	}

	if (bucketName.includes('/') || bucketName.includes('\\')) {
		return false;
	}

	const bucketNameRegex = /^[\w!.\*'() &$@=;:+,?-]+$/;
	return bucketNameRegex.test(bucketName);
};

export const normalizeToFloat32 = (values: number[]): number[] => {
	return Array.from(new Float32Array(values));
};

export const validateVectorDimension = (vector: { float32: number[] }, expectedDimension?: number): void => {
	if (expectedDimension !== undefined && vector.float32.length !== expectedDimension) {
		throw new Error(`Vector dimension mismatch: expected ${expectedDimension}, got ${vector.float32.length}`);
	}
};
