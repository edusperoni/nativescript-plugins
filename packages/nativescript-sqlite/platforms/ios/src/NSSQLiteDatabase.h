#import <Foundation/Foundation.h>

@interface NSSQLiteDatabase : NSObject

/**
 * Every connection is opened by the queue that owns it, so key derivation never
 * runs on the calling thread. The writer is the exception unless `asyncOpen` is
 * YES: it is opened here, so a bad path, a wrong key or a failing open step
 * returns nil with `error` set. With `asyncOpen` the open always succeeds here
 * and the failure arrives through `initializedWithCompletion:` and through every
 * operation instead. Readers start only once the writer has opened; if it fails
 * they take on its failure without touching the file.
 *
 * `openSequence` is each connection's setup in order, already resolved and
 * validated by the JavaScript layer, so it is run as given. Every element carries
 * `kind` (0 run `sql`, 1 apply `encryptionKey`, 2 switch to WAL) and `scope`
 * (0 every connection, 1 the writer, 2 the readers). In serialized mode the
 * single connection is the writer.
 */
+ (instancetype)openWithPath:(NSString *)path
                    poolSize:(int)poolSize
                    readOnly:(BOOL)readOnly
                 busyTimeout:(int)busyTimeoutMs
               encryptionKey:(NSString *)encryptionKey
                openSequence:(NSArray<NSDictionary<NSString *, id> *> *)openSequence
                  serialized:(BOOL)serialized
                   asyncOpen:(BOOL)asyncOpen
                       error:(NSError **)error;

/** Completes with the first open failure, or nil, once every connection has finished opening. */
- (void)initializedWithCompletion:(void (^)(NSError *))completion;

// --- Async operations (dispatch to GCD, callback on main queue) ---

- (void)execute:(NSString *)sql
         params:(NSArray *)params
     completion:(void (^)(NSError *))completion;

// select returns JSON: [{col:val,...}, ...]
- (void)select:(NSString *)sql
        params:(NSArray *)params
    completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

// selectArray returns JSON: {"columns":[...],"rows":[[...], ...]}
- (void)selectArray:(NSString *)sql
             params:(NSArray *)params
         completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

// --- Write transactions ---

- (void)beginTransaction:(NSString *)behavior
              completion:(void (^)(int, NSError *))completion;

- (void)executeInTransaction:(int)txId
                         sql:(NSString *)sql
                      params:(NSArray *)params
                  completion:(void (^)(NSError *))completion;

- (void)selectInTransaction:(int)txId
                        sql:(NSString *)sql
                     params:(NSArray *)params
                 completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

- (void)selectArrayInTransaction:(int)txId
                             sql:(NSString *)sql
                          params:(NSArray *)params
                      completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

- (void)commitTransaction:(int)txId
               completion:(void (^)(NSError *))completion;

- (void)rollbackTransaction:(int)txId
                 completion:(void (^)(NSError *))completion;

// --- Read transactions ---

- (void)beginReadTransaction:(void (^)(int, NSError *))completion;

- (void)selectInReadTransaction:(int)txId
                            sql:(NSString *)sql
                         params:(NSArray *)params
                     completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

- (void)selectArrayInReadTransaction:(int)txId
                                 sql:(NSString *)sql
                              params:(NSArray *)params
                          completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

- (void)endReadTransaction:(int)txId
                completion:(void (^)(NSError *))completion;

// --- Prepared statements ---

- (void)prepare:(NSString *)sql
     completion:(void (^)(int, NSError *))completion;

- (void)executePrepared:(int)stmtId
                 params:(NSArray *)params
             completion:(void (^)(NSError *))completion;

- (void)selectPrepared:(int)stmtId
                params:(NSArray *)params
            completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

- (void)selectArrayPrepared:(int)stmtId
                     params:(NSArray *)params
                 completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion;

- (void)finalizePrepared:(int)stmtId
              completion:(void (^)(NSError *))completion;

// --- Sync operations (blocks calling thread) ---

/**
 * Every sync method runs on the writer connection, ordered against the
 * asynchronous work already queued on it. None may be called from a block
 * running on the writer queue — that would deadlock.
 */

- (NSString *)selectSync:(NSString *)sql
                  params:(NSArray *)params
                   blobs:(NSArray<NSData *> **)outBlobs
                   error:(NSError **)error;

- (NSString *)selectArraySync:(NSString *)sql
                       params:(NSArray *)params
                        blobs:(NSArray<NSData *> **)outBlobs
                        error:(NSError **)error;

/**
 * Fails with SQLITE_BUSY while a transaction opened through beginTransaction:
 * is active, so the statement cannot silently join it. `joinTransaction` opts
 * out of that check and runs the statement inside whatever is open.
 */
- (BOOL)executeSync:(NSString *)sql
             params:(NSArray *)params
    joinTransaction:(BOOL)joinTransaction
              error:(NSError **)error;

// --- Sync operations inside a transaction ---

/**
 * Run on the connection that owns `txId` — the writer for a write transaction,
 * its own reader for a read transaction — and never trip the SQLITE_BUSY
 * safeguard. An unknown or already-finished id fails with SQLITE_MISUSE.
 */

- (BOOL)executeInTransactionSync:(int)txId
                             sql:(NSString *)sql
                          params:(NSArray *)params
                           error:(NSError **)error;

- (NSString *)selectInTransactionSync:(int)txId
                                  sql:(NSString *)sql
                               params:(NSArray *)params
                                blobs:(NSArray<NSData *> **)outBlobs
                                error:(NSError **)error;

- (NSString *)selectArrayInTransactionSync:(int)txId
                                       sql:(NSString *)sql
                                    params:(NSArray *)params
                                     blobs:(NSArray<NSData *> **)outBlobs
                                     error:(NSError **)error;

/**
 * Opens a transaction the calling thread drives directly. The writer queue is
 * first drained and then held until endTransactionSync:commit:error:, so
 * nothing dispatched asynchronously — before the span or from inside it — can
 * run against the connection while the transaction is open.
 *
 * Returns the transaction id, or -1 with `error` set. The caller must always
 * reach endTransactionSync:commit:error:, or the writer queue stays held.
 */
- (int)beginTransactionSync:(NSString *)behavior
                      error:(NSError **)error;

/** Releases the writer queue. An id that is not the open span is a no-op. */
- (BOOL)endTransactionSync:(int)txId
                    commit:(BOOL)commit
                     error:(NSError **)error;

// --- Runtime info ---

/**
 * Keys: `version`, `sourceId`, `compileOptions` (NSArray<NSString *> *).
 * Reports the linked SQLite library, so it stays valid on a closed database.
 */
- (NSDictionary<NSString *, id> *)runtimeInfo;

// --- Lifecycle ---

- (void)closeWithCompletion:(void (^)(void))completion;
- (void)close;

@property (nonatomic, readonly) BOOL isOpen;

@end
