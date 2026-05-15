#import <Foundation/Foundation.h>

@interface NSSQLiteDatabase : NSObject

+ (instancetype)openWithPath:(NSString *)path
                    poolSize:(int)poolSize
                    readOnly:(BOOL)readOnly
                 busyTimeout:(int)busyTimeoutMs;

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

- (void)beginTransaction:(void (^)(int, NSError *))completion;

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

- (NSString *)selectSync:(NSString *)sql
                  params:(NSArray *)params
                   error:(NSError **)error;

- (NSString *)selectArraySync:(NSString *)sql
                       params:(NSArray *)params
                        error:(NSError **)error;

- (BOOL)executeSync:(NSString *)sql
             params:(NSArray *)params
              error:(NSError **)error;

// --- Lifecycle ---

- (void)close;

@property (nonatomic, readonly) BOOL isOpen;

@end
