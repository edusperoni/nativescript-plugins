import { StorageError } from './common/errors';

export type BucketType = 'STANDARD' | 'ANALYTICS' | (string & {});

export interface Bucket {
	id: string;
	type?: BucketType;
	name: string;
	owner: string;
	file_size_limit?: number;
	allowed_mime_types?: string[];
	created_at: string;
	updated_at: string;
	public: boolean;
}

export interface ListBucketOptions {
	limit?: number;
	offset?: number;
	sortColumn?: 'id' | 'name' | 'created_at' | 'updated_at';
	sortOrder?: 'asc' | 'desc';
	search?: string;
}

export interface AnalyticBucket {
	name: string;
	type: 'ANALYTICS';
	format: string;
	created_at: string;
	updated_at: string;
}

export interface FileMetadata {
	eTag: string;
	size: number;
	mimetype: string;
	cacheControl: string;
	lastModified: string;
	contentLength: number;
	httpStatusCode: number;
	[key: string]: any;
}

export interface FileObject {
	name: string;
	id: string | null;
	updated_at: string | null;
	created_at: string | null;
	/** @deprecated */
	last_accessed_at: string | null;
	metadata: FileMetadata | null;
	/** @deprecated */
	bucket_id?: string;
	/** @deprecated */
	owner?: string;
	/** @deprecated */
	buckets?: Bucket;
}

export interface FileObjectV2 {
	id: string;
	version: string;
	name: string;
	bucket_id: string;
	created_at: string;
	size?: number;
	cache_control?: string;
	content_type?: string;
	etag?: string;
	last_modified?: string;
	metadata?: FileMetadata;
	/** @deprecated The API returns last_modified instead. */
	updated_at?: string;
}

export interface SortBy {
	column?: string;
	order?: string;
}

export interface FileOptions {
	cacheControl?: string;
	contentType?: string;
	upsert?: boolean;
	duplex?: string;
	metadata?: Record<string, any>;
	headers?: Record<string, string>;
}

export interface DestinationOptions {
	destinationBucket?: string;
}

export interface SearchOptions {
	/** @default 100 */
	limit?: number;
	offset?: number;
	sortBy?: SortBy;
	search?: string;
}

export interface SortByV2 {
	column: 'name' | 'updated_at' | 'created_at';
	order?: 'asc' | 'desc';
}

export interface SearchV2Options {
	/** @default 1000 */
	limit?: number;
	prefix?: string;
	cursor?: string;
	/** @default false */
	with_delimiter?: boolean;
	/** @default 'name asc' */
	sortBy?: SortByV2;
}

export interface SearchV2Object {
	name: string;
	key?: string;
	id: string;
	updated_at: string;
	created_at: string;
	metadata: FileMetadata | null;
	/** @deprecated */
	last_accessed_at: string;
}

export interface SearchV2Folder {
	name: string;
	key?: string;
}

export interface SearchV2Result {
	hasNext: boolean;
	folders: SearchV2Folder[];
	objects: SearchV2Object[];
	nextCursor?: string;
}

export interface FetchParameters {
	signal?: AbortSignal;
	cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached';
}

export interface Metadata {
	name: string;
}

export interface TransformOptions {
	width?: number;
	height?: number;
	resize?: 'cover' | 'contain' | 'fill';
	quality?: number;
	format?: 'origin';
}

type CamelCase<S extends string> = S extends `${infer P1}_${infer P2}${infer P3}` ? `${Lowercase<P1>}${Uppercase<P2>}${CamelCase<P3>}` : S;

export type Camelize<T> = {
	[K in keyof T as CamelCase<Extract<K, string>>]: T[K];
};

export type DownloadResult<T> =
	| {
			data: T;
			error: null;
	  }
	| {
			data: null;
			error: StorageError;
	  };

// Vector Storage Types

export interface EncryptionConfiguration {
	kmsKeyArn?: string;
	sseType?: string;
}

export interface VectorBucket {
	vectorBucketName: string;
	creationTime?: number;
	encryptionConfiguration?: EncryptionConfiguration;
}

export interface MetadataConfiguration {
	nonFilterableMetadataKeys?: string[];
}

export type VectorDataType = 'float32' | (string & {});

export type DistanceMetric = 'cosine' | 'euclidean' | 'dotproduct' | (string & {});

export interface VectorIndex {
	indexName: string;
	vectorBucketName: string;
	dataType: VectorDataType;
	dimension: number;
	distanceMetric: DistanceMetric;
	metadataConfiguration?: MetadataConfiguration;
	creationTime?: number;
}

export interface VectorData {
	float32: number[];
}

export type VectorMetadata = Record<string, any>;

export interface VectorObject {
	key: string;
	data: VectorData;
	metadata?: VectorMetadata;
}

export interface VectorMatch {
	key: string;
	data?: VectorData;
	metadata?: VectorMetadata;
	distance?: number;
}

export interface ListVectorBucketsOptions {
	prefix?: string;
	maxResults?: number;
	nextToken?: string;
}

export interface ListVectorBucketsResponse {
	vectorBuckets: { vectorBucketName: string }[];
	nextToken?: string;
}

export interface ListIndexesOptions {
	vectorBucketName: string;
	prefix?: string;
	maxResults?: number;
	nextToken?: string;
}

export interface ListIndexesResponse {
	indexes: { indexName: string }[];
	nextToken?: string;
}

export interface GetVectorsOptions {
	vectorBucketName: string;
	indexName: string;
	keys: string[];
	returnData?: boolean;
	returnMetadata?: boolean;
}

export interface GetVectorsResponse {
	vectors: VectorMatch[];
}

export interface PutVectorsOptions {
	vectorBucketName: string;
	indexName: string;
	vectors: VectorObject[];
}

export interface DeleteVectorsOptions {
	vectorBucketName: string;
	indexName: string;
	keys: string[];
}

export interface ListVectorsOptions {
	vectorBucketName: string;
	indexName: string;
	maxResults?: number;
	nextToken?: string;
	returnData?: boolean;
	returnMetadata?: boolean;
	segmentCount?: number;
	segmentIndex?: number;
}

export interface ListVectorsResponse {
	vectors: VectorMatch[];
	nextToken?: string;
}

export type VectorFilter = Record<string, any>;

export interface QueryVectorsOptions {
	vectorBucketName: string;
	indexName: string;
	queryVector: VectorData;
	topK?: number;
	filter?: VectorFilter;
	returnDistance?: boolean;
	returnMetadata?: boolean;
}

export interface QueryVectorsResponse {
	vectors: VectorMatch[];
	distanceMetric?: DistanceMetric;
}

export interface VectorFetchParameters {
	signal?: AbortSignal;
}

export interface SuccessResponse<T> {
	data: T;
	error: null;
}

export interface ErrorResponse {
	data: null;
	error: StorageError;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;
