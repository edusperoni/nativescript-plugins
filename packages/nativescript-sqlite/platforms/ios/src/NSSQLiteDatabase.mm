#import "NSSQLiteDatabase.h"
#include <sqlite3.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <cstring>

// MARK: - JSON String Builder

class JSONBuilder {
    std::string buf_;
public:
    JSONBuilder() { buf_.reserve(4096); }

    void reset() { buf_.clear(); }
    const std::string &str() const { return buf_; }

    void appendRaw(const char *s, size_t len) { buf_.append(s, len); }
    void appendRaw(char c) { buf_.push_back(c); }

    void appendNull() { buf_.append("null", 4); }
    void appendBool(bool v) { v ? buf_.append("true", 4) : buf_.append("false", 5); }

    void appendInt(int64_t v) {
        char tmp[32];
        int n = snprintf(tmp, sizeof(tmp), "%lld", (long long)v);
        buf_.append(tmp, n);
    }

    void appendDouble(double v) {
        char tmp[64];
        int n = snprintf(tmp, sizeof(tmp), "%.17g", v);
        buf_.append(tmp, n);
    }

    void appendString(const char *s, int len) {
        buf_.push_back('"');
        const char *end = s + len;
        while (s < end) {
            unsigned char c = *s;
            switch (c) {
                case '"':  buf_.append("\\\"", 2); break;
                case '\\': buf_.append("\\\\", 2); break;
                case '\b': buf_.append("\\b", 2); break;
                case '\f': buf_.append("\\f", 2); break;
                case '\n': buf_.append("\\n", 2); break;
                case '\r': buf_.append("\\r", 2); break;
                case '\t': buf_.append("\\t", 2); break;
                default:
                    if (c < 0x20) {
                        char esc[8];
                        snprintf(esc, sizeof(esc), "\\u%04x", c);
                        buf_.append(esc, 6);
                    } else {
                        buf_.push_back(c);
                    }
                    break;
            }
            s++;
        }
        buf_.push_back('"');
    }

    void appendBlobPlaceholder(int index) {
        buf_.append("{\"__blob__\":", 11);
        appendInt(index);
        buf_.push_back('}');
    }
};

// MARK: - SQLite Connection

class SQLiteConnection {
    sqlite3 *db_ = nullptr;
    std::string path_;

public:
    SQLiteConnection() = default;
    ~SQLiteConnection() { close(); }

    SQLiteConnection(const SQLiteConnection &) = delete;
    SQLiteConnection &operator=(const SQLiteConnection &) = delete;

    sqlite3 *handle() const { return db_; }

    bool open(const std::string &path, int flags, int busyTimeoutMs, std::string &outError) {
        int rc = sqlite3_open_v2(path.c_str(), &db_, flags, nullptr);
        if (rc != SQLITE_OK) {
            outError = db_ ? sqlite3_errmsg(db_) : "Failed to allocate memory for database";
            if (db_) { sqlite3_close(db_); db_ = nullptr; }
            return false;
        }
        path_ = path;
        sqlite3_extended_result_codes(db_, 1);
        sqlite3_busy_timeout(db_, busyTimeoutMs);
        return true;
    }

    bool configureWAL(std::string &outError) {
        char *errMsg = nullptr;
        int rc = sqlite3_exec(db_, "PRAGMA journal_mode=WAL", nullptr, nullptr, &errMsg);
        if (rc != SQLITE_OK) {
            outError = errMsg ? errMsg : "Failed to set WAL mode";
            if (errMsg) sqlite3_free(errMsg);
            return false;
        }
        return true;
    }

    void close() {
        if (db_) {
            sqlite3_close_v2(db_);
            db_ = nullptr;
        }
    }

    int lastErrorCode() const { return db_ ? sqlite3_errcode(db_) : SQLITE_ERROR; }
    int lastExtendedErrorCode() const { return db_ ? sqlite3_extended_errcode(db_) : SQLITE_ERROR; }
    const char *lastErrorMsg() const { return db_ ? sqlite3_errmsg(db_) : "Database not open"; }

    bool execute(const char *sql, std::string &outError) {
        char *errMsg = nullptr;
        int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &errMsg);
        if (rc != SQLITE_OK) {
            outError = errMsg ? errMsg : sqlite3_errmsg(db_);
            if (errMsg) sqlite3_free(errMsg);
            return false;
        }
        return true;
    }
};

// MARK: - Parameter Binding

static bool bindParams(sqlite3_stmt *stmt, NSArray *params, std::string &outError) {
    if (!params || params.count == 0) return true;

    id first = params[0];
    bool isDict = [first isKindOfClass:[NSString class]] && params.count == 2 && [params[1] isKindOfClass:[NSDictionary class]];

    if ([first isKindOfClass:[NSDictionary class]]) {
        NSDictionary *dict = (NSDictionary *)first;
        for (NSString *key in dict) {
            NSString *paramName = [key hasPrefix:@":"] || [key hasPrefix:@"$"] || [key hasPrefix:@"@"]
                ? key
                : [@":" stringByAppendingString:key];
            int idx = sqlite3_bind_parameter_index(stmt, [paramName UTF8String]);
            if (idx == 0) {
                outError = std::string("Unknown parameter: ") + [paramName UTF8String];
                return false;
            }
            id value = dict[key];
            if ([value isKindOfClass:[NSNull class]] || value == nil) {
                sqlite3_bind_null(stmt, idx);
            } else if ([value isKindOfClass:[NSNumber class]]) {
                NSNumber *num = (NSNumber *)value;
                const char *type = [num objCType];
                if (strcmp(type, @encode(BOOL)) == 0 || strcmp(type, @encode(char)) == 0) {
                    sqlite3_bind_int(stmt, idx, [num intValue]);
                } else if (strcmp(type, @encode(int)) == 0 || strcmp(type, @encode(long)) == 0 ||
                           strcmp(type, @encode(long long)) == 0 || strcmp(type, @encode(short)) == 0) {
                    sqlite3_bind_int64(stmt, idx, [num longLongValue]);
                } else {
                    sqlite3_bind_double(stmt, idx, [num doubleValue]);
                }
            } else if ([value isKindOfClass:[NSString class]]) {
                const char *utf8 = [(NSString *)value UTF8String];
                sqlite3_bind_text(stmt, idx, utf8, -1, SQLITE_TRANSIENT);
            } else if ([value isKindOfClass:[NSData class]]) {
                NSData *data = (NSData *)value;
                sqlite3_bind_blob(stmt, idx, data.bytes, (int)data.length, SQLITE_TRANSIENT);
            }
        }
        return true;
    }

    for (NSUInteger i = 0; i < params.count; i++) {
        int idx = (int)(i + 1);
        id value = params[i];
        if ([value isKindOfClass:[NSNull class]] || value == nil) {
            sqlite3_bind_null(stmt, idx);
        } else if ([value isKindOfClass:[NSNumber class]]) {
            NSNumber *num = (NSNumber *)value;
            const char *type = [num objCType];
            if (strcmp(type, @encode(BOOL)) == 0 || strcmp(type, @encode(char)) == 0) {
                sqlite3_bind_int(stmt, idx, [num intValue]);
            } else if (strcmp(type, @encode(int)) == 0 || strcmp(type, @encode(long)) == 0 ||
                       strcmp(type, @encode(long long)) == 0 || strcmp(type, @encode(short)) == 0) {
                sqlite3_bind_int64(stmt, idx, [num longLongValue]);
            } else {
                sqlite3_bind_double(stmt, idx, [num doubleValue]);
            }
        } else if ([value isKindOfClass:[NSString class]]) {
            const char *utf8 = [(NSString *)value UTF8String];
            sqlite3_bind_text(stmt, idx, utf8, -1, SQLITE_TRANSIENT);
        } else if ([value isKindOfClass:[NSData class]]) {
            NSData *data = (NSData *)value;
            sqlite3_bind_blob(stmt, idx, data.bytes, (int)data.length, SQLITE_TRANSIENT);
        }
    }
    return true;
}

// MARK: - Statement Execution

struct ExecuteResult {
    bool success;
    std::string error;
    int errorCode;
    int extendedErrorCode;
};

static ExecuteResult executeSQL(SQLiteConnection &conn, const char *sql, NSArray *params) {
    ExecuteResult result = {true, "", SQLITE_OK, SQLITE_OK};
    sqlite3_stmt *stmt = nullptr;

    int rc = sqlite3_prepare_v2(conn.handle(), sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        result.success = false;
        result.error = conn.lastErrorMsg();
        result.errorCode = conn.lastErrorCode();
        result.extendedErrorCode = conn.lastExtendedErrorCode();
        return result;
    }

    if (!bindParams(stmt, params, result.error)) {
        result.success = false;
        result.errorCode = SQLITE_ERROR;
        result.extendedErrorCode = SQLITE_ERROR;
        sqlite3_finalize(stmt);
        return result;
    }

    rc = sqlite3_step(stmt);
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
        result.success = false;
        result.error = conn.lastErrorMsg();
        result.errorCode = conn.lastErrorCode();
        result.extendedErrorCode = conn.lastExtendedErrorCode();
    }

    sqlite3_finalize(stmt);
    return result;
}

static void appendColumnValue(sqlite3_stmt *stmt, int i, JSONBuilder &json, std::vector<NSData *> &blobs) {
    int colType = sqlite3_column_type(stmt, i);
    switch (colType) {
        case SQLITE_INTEGER:
            json.appendInt(sqlite3_column_int64(stmt, i));
            break;
        case SQLITE_FLOAT:
            json.appendDouble(sqlite3_column_double(stmt, i));
            break;
        case SQLITE_TEXT: {
            const char *text = (const char *)sqlite3_column_text(stmt, i);
            int bytes = sqlite3_column_bytes(stmt, i);
            json.appendString(text, bytes);
            break;
        }
        case SQLITE_BLOB: {
            const void *data = sqlite3_column_blob(stmt, i);
            int bytes = sqlite3_column_bytes(stmt, i);
            NSData *blobData = [NSData dataWithBytes:data length:bytes];
            int blobIdx = (int)blobs.size();
            blobs.push_back(blobData);
            json.appendBlobPlaceholder(blobIdx);
            break;
        }
        case SQLITE_NULL:
        default:
            json.appendNull();
            break;
    }
}

struct SelectResult {
    bool success;
    std::string json;
    std::vector<NSData *> blobs;
    std::string error;
    int errorCode;
    int extendedErrorCode;
};

static SelectResult selectSQL(SQLiteConnection &conn, const char *sql, NSArray *params) {
    SelectResult result = {true, "", {}, "", SQLITE_OK, SQLITE_OK};
    sqlite3_stmt *stmt = nullptr;

    int rc = sqlite3_prepare_v2(conn.handle(), sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        result.success = false;
        result.error = conn.lastErrorMsg();
        result.errorCode = conn.lastErrorCode();
        result.extendedErrorCode = conn.lastExtendedErrorCode();
        return result;
    }

    if (!bindParams(stmt, params, result.error)) {
        result.success = false;
        result.errorCode = SQLITE_ERROR;
        result.extendedErrorCode = SQLITE_ERROR;
        sqlite3_finalize(stmt);
        return result;
    }

    int colCount = sqlite3_column_count(stmt);
    std::vector<std::string> colNames;
    colNames.reserve(colCount);
    bool namesCollected = false;

    JSONBuilder json;
    json.appendRaw('[');
    bool firstRow = true;

    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (!namesCollected) {
            for (int i = 0; i < colCount; i++) {
                const char *name = sqlite3_column_name(stmt, i);
                colNames.emplace_back(name ? name : "");
            }
            namesCollected = true;
        }

        if (!firstRow) json.appendRaw(',');
        firstRow = false;
        json.appendRaw('{');

        for (int i = 0; i < colCount; i++) {
            if (i > 0) json.appendRaw(',');
            json.appendString(colNames[i].c_str(), (int)colNames[i].length());
            json.appendRaw(':');
            appendColumnValue(stmt, i, json, result.blobs);
        }
        json.appendRaw('}');
    }

    json.appendRaw(']');

    if (rc != SQLITE_DONE) {
        result.success = false;
        result.error = conn.lastErrorMsg();
        result.errorCode = conn.lastErrorCode();
        result.extendedErrorCode = conn.lastExtendedErrorCode();
    } else {
        result.json = json.str();
    }

    sqlite3_finalize(stmt);
    return result;
}

static SelectResult selectArraySQL(SQLiteConnection &conn, const char *sql, NSArray *params) {
    SelectResult result = {true, "", {}, "", SQLITE_OK, SQLITE_OK};
    sqlite3_stmt *stmt = nullptr;

    int rc = sqlite3_prepare_v2(conn.handle(), sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        result.success = false;
        result.error = conn.lastErrorMsg();
        result.errorCode = conn.lastErrorCode();
        result.extendedErrorCode = conn.lastExtendedErrorCode();
        return result;
    }

    if (!bindParams(stmt, params, result.error)) {
        result.success = false;
        result.errorCode = SQLITE_ERROR;
        result.extendedErrorCode = SQLITE_ERROR;
        sqlite3_finalize(stmt);
        return result;
    }

    int colCount = sqlite3_column_count(stmt);

    JSONBuilder json;
    // {"columns":[...],"rows":[[...], ...]}
    json.appendRaw("{\"columns\":[", 12);
    for (int i = 0; i < colCount; i++) {
        if (i > 0) json.appendRaw(',');
        const char *name = sqlite3_column_name(stmt, i);
        json.appendString(name ? name : "", name ? (int)strlen(name) : 0);
    }
    json.appendRaw("],\"rows\":[", 10);

    bool firstRow = true;
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (!firstRow) json.appendRaw(',');
        firstRow = false;
        json.appendRaw('[');
        for (int i = 0; i < colCount; i++) {
            if (i > 0) json.appendRaw(',');
            appendColumnValue(stmt, i, json, result.blobs);
        }
        json.appendRaw(']');
    }

    json.appendRaw("]}", 2);

    if (rc != SQLITE_DONE) {
        result.success = false;
        result.error = conn.lastErrorMsg();
        result.errorCode = conn.lastErrorCode();
        result.extendedErrorCode = conn.lastExtendedErrorCode();
    } else {
        result.json = json.str();
    }

    sqlite3_finalize(stmt);
    return result;
}

// MARK: - Prepared Statement Handle

struct PreparedStmtHandle {
    sqlite3_stmt *stmt;
    SQLiteConnection *conn;
    dispatch_queue_t queue;
};

// MARK: - Read Transaction Handle

struct ReadTxHandle {
    SQLiteConnection *conn;
    dispatch_queue_t queue;
    int readerIndex;
};

// MARK: - NSSQLiteDatabase Implementation

@implementation NSSQLiteDatabase {
    SQLiteConnection _writerConn;
    std::vector<SQLiteConnection *> _readerConns;
    SQLiteConnection _syncConn;
    bool _syncConnOpened;

    dispatch_queue_t _writerQueue;
    std::vector<dispatch_queue_t> _readerQueues;
    std::atomic<int> _readerIndex;

    std::string _path;
    int _busyTimeoutMs;
    BOOL _readOnly;
    BOOL _isOpen;

    std::atomic<int> _nextTxId;
    std::atomic<int> _nextStmtId;

    std::mutex _txMutex;
    bool _hasActiveWriteTx;
    std::vector<std::pair<std::string, void (^)(int, NSError *)>> _pendingTxStarts;

    std::mutex _stmtMutex;
    std::unordered_map<int, PreparedStmtHandle> _preparedStmts;

    std::mutex _readTxMutex;
    std::unordered_map<int, ReadTxHandle> _readTxHandles;
    std::vector<bool> _readerAvailable;
}

+ (instancetype)openWithPath:(NSString *)path
                    poolSize:(int)poolSize
                    readOnly:(BOOL)readOnly
                 busyTimeout:(int)busyTimeoutMs {
    NSSQLiteDatabase *db = [[NSSQLiteDatabase alloc] init];
    if (![db _openWithPath:path poolSize:poolSize readOnly:readOnly busyTimeout:busyTimeoutMs]) {
        return nil;
    }
    return db;
}

- (BOOL)_openWithPath:(NSString *)path
             poolSize:(int)poolSize
             readOnly:(BOOL)readOnly
          busyTimeout:(int)busyTimeoutMs {
    _path = [path UTF8String];
    _busyTimeoutMs = busyTimeoutMs;
    _readOnly = readOnly;
    _syncConnOpened = false;
    _readerIndex = 0;
    _nextTxId = 1;
    _nextStmtId = 1;
    _hasActiveWriteTx = false;

    std::string error;

    int writerFlags = readOnly
        ? (SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX)
        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX);

    if (!_writerConn.open(_path, writerFlags, busyTimeoutMs, error)) {
        NSLog(@"[NSSQLiteDatabase] Failed to open writer: %s", error.c_str());
        return NO;
    }

    if (!readOnly) {
        if (!_writerConn.configureWAL(error)) {
            NSLog(@"[NSSQLiteDatabase] Failed to enable WAL: %s", error.c_str());
            _writerConn.close();
            return NO;
        }
    }

    NSString *writerLabel = [NSString stringWithFormat:@"com.nssqlite.writer.%@", [path lastPathComponent]];
    _writerQueue = dispatch_queue_create([writerLabel UTF8String], DISPATCH_QUEUE_SERIAL);

    if (poolSize < 1) poolSize = 1;

    for (int i = 0; i < poolSize; i++) {
        auto *reader = new SQLiteConnection();
        int readerFlags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX;
        if (!reader->open(_path, readerFlags, busyTimeoutMs, error)) {
            NSLog(@"[NSSQLiteDatabase] Failed to open reader %d: %s", i, error.c_str());
            delete reader;
            continue;
        }
        _readerConns.push_back(reader);
        _readerAvailable.push_back(true);

        NSString *label = [NSString stringWithFormat:@"com.nssqlite.reader.%d.%@", i, [path lastPathComponent]];
        _readerQueues.push_back(dispatch_queue_create([label UTF8String], DISPATCH_QUEUE_SERIAL));
    }

    _isOpen = YES;
    return YES;
}

- (BOOL)isOpen {
    return _isOpen;
}

// MARK: - Async Execute

- (void)execute:(NSString *)sql
         params:(NSArray *)params
     completion:(void (^)(NSError *))completion {
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(_writerQueue, ^{
        auto result = executeSQL(self->_writerConn, sqlUTF8, paramsCopy);
        free((void *)sqlUTF8);

        if (completion) {
            NSError *error = result.success ? nil : [self _errorWithMessage:result.error
                                                                      code:result.errorCode
                                                              extendedCode:result.extendedErrorCode];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(error);
            });
        }
    });
}

// MARK: - Select Result Dispatch Helper

- (void)_dispatchSelectResult:(const SelectResult &)result
                   completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    if (!completion) return;
    if (result.success) {
        NSString *jsonStr = [[NSString alloc] initWithUTF8String:result.json.c_str()];
        NSMutableArray<NSData *> *blobs = nil;
        if (!result.blobs.empty()) {
            blobs = [NSMutableArray arrayWithCapacity:result.blobs.size()];
            for (auto &b : result.blobs) [blobs addObject:b];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(jsonStr, blobs, nil);
        });
    } else {
        NSError *error = [self _errorWithMessage:result.error
                                            code:result.errorCode
                                    extendedCode:result.extendedErrorCode];
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(nil, nil, error);
        });
    }
}

// MARK: - Async Select

- (void)select:(NSString *)sql
        params:(NSArray *)params
    completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    int idx = _readerIndex.fetch_add(1) % (int)_readerQueues.size();
    dispatch_queue_t queue = _readerQueues[idx];
    SQLiteConnection *conn = _readerConns[idx];
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(queue, ^{
        auto result = selectSQL(*conn, sqlUTF8, paramsCopy);
        free((void *)sqlUTF8);
        [self _dispatchSelectResult:result completion:completion];
    });
}

// MARK: - Async Select Array

- (void)selectArray:(NSString *)sql
             params:(NSArray *)params
         completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    int idx = _readerIndex.fetch_add(1) % (int)_readerQueues.size();
    dispatch_queue_t queue = _readerQueues[idx];
    SQLiteConnection *conn = _readerConns[idx];
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(queue, ^{
        auto result = selectArraySQL(*conn, sqlUTF8, paramsCopy);
        free((void *)sqlUTF8);
        [self _dispatchSelectResult:result completion:completion];
    });
}

// MARK: - Write Transactions

- (void)beginTransaction:(NSString *)behavior
              completion:(void (^)(int, NSError *))completion {
    std::string beginSQL = "BEGIN";
    if (behavior && behavior.length > 0) {
        beginSQL += " ";
        beginSQL += [behavior UTF8String];
    }

    std::lock_guard<std::mutex> lock(_txMutex);
    if (_hasActiveWriteTx) {
        _pendingTxStarts.push_back({beginSQL, [completion copy]});
        return;
    }
    _hasActiveWriteTx = true;
    [self _startTransaction:beginSQL completion:completion];
}

- (void)_startTransaction:(const std::string &)beginSQL
               completion:(void (^)(int, NSError *))completion {
    int txId = _nextTxId.fetch_add(1);
    std::string sql = beginSQL;

    dispatch_async(_writerQueue, ^{
        std::string error;
        bool ok = self->_writerConn.execute(sql.c_str(), error);
        if (!ok) {
            {
                std::lock_guard<std::mutex> lock(self->_txMutex);
                self->_hasActiveWriteTx = false;
            }
            NSError *nsError = [self _errorWithMessage:error
                                                  code:self->_writerConn.lastErrorCode()
                                          extendedCode:self->_writerConn.lastExtendedErrorCode()];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(-1, nsError);
            });
            [self _flushPendingTransactions];
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(txId, nil);
        });
    });
}

- (void)executeInTransaction:(int)txId
                         sql:(NSString *)sql
                      params:(NSArray *)params
                  completion:(void (^)(NSError *))completion {
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(_writerQueue, ^{
        auto result = executeSQL(self->_writerConn, sqlUTF8, paramsCopy);
        free((void *)sqlUTF8);

        if (completion) {
            NSError *error = result.success ? nil : [self _errorWithMessage:result.error
                                                                      code:result.errorCode
                                                              extendedCode:result.extendedErrorCode];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(error);
            });
        }
    });
}

- (void)_selectOnWriter:(NSString *)sql
                 params:(NSArray *)params
               arrayMode:(BOOL)arrayMode
              completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(_writerQueue, ^{
        auto result = arrayMode
            ? selectArraySQL(self->_writerConn, sqlUTF8, paramsCopy)
            : selectSQL(self->_writerConn, sqlUTF8, paramsCopy);
        free((void *)sqlUTF8);
        [self _dispatchSelectResult:result completion:completion];
    });
}

- (void)selectInTransaction:(int)txId
                        sql:(NSString *)sql
                     params:(NSArray *)params
                 completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    [self _selectOnWriter:sql params:params arrayMode:NO completion:completion];
}

- (void)selectArrayInTransaction:(int)txId
                             sql:(NSString *)sql
                          params:(NSArray *)params
                      completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    [self _selectOnWriter:sql params:params arrayMode:YES completion:completion];
}

- (void)commitTransaction:(int)txId
               completion:(void (^)(NSError *))completion {
    dispatch_async(_writerQueue, ^{
        std::string error;
        bool ok = self->_writerConn.execute("COMMIT", error);
        {
            std::lock_guard<std::mutex> lock(self->_txMutex);
            self->_hasActiveWriteTx = false;
        }
        NSError *nsError = ok ? nil : [self _errorWithMessage:error
                                                         code:self->_writerConn.lastErrorCode()
                                                 extendedCode:self->_writerConn.lastExtendedErrorCode()];
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(nsError);
        });
        [self _flushPendingTransactions];
    });
}

- (void)rollbackTransaction:(int)txId
                 completion:(void (^)(NSError *))completion {
    dispatch_async(_writerQueue, ^{
        std::string error;
        self->_writerConn.execute("ROLLBACK", error);
        {
            std::lock_guard<std::mutex> lock(self->_txMutex);
            self->_hasActiveWriteTx = false;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(nil);
        });
        [self _flushPendingTransactions];
    });
}

- (void)_flushPendingTransactions {
    std::lock_guard<std::mutex> lock(_txMutex);
    if (_pendingTxStarts.empty() || _hasActiveWriteTx) return;

    auto next = _pendingTxStarts.front();
    _pendingTxStarts.erase(_pendingTxStarts.begin());
    _hasActiveWriteTx = true;
    [self _startTransaction:next.first completion:next.second];
}

// MARK: - Read Transactions

- (void)beginReadTransaction:(void (^)(int, NSError *))completion {
    int readerIdx = -1;
    {
        std::lock_guard<std::mutex> lock(_readTxMutex);
        for (int i = 0; i < (int)_readerAvailable.size(); i++) {
            if (_readerAvailable[i]) {
                _readerAvailable[i] = false;
                readerIdx = i;
                break;
            }
        }
    }

    if (readerIdx < 0) {
        NSError *error = [self _errorWithMessage:"No available reader connections" code:SQLITE_BUSY extendedCode:SQLITE_BUSY];
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(-1, error);
        });
        return;
    }

    int txId = _nextTxId.fetch_add(1);
    SQLiteConnection *conn = _readerConns[readerIdx];
    dispatch_queue_t queue = _readerQueues[readerIdx];

    {
        std::lock_guard<std::mutex> lock(_readTxMutex);
        _readTxHandles[txId] = {conn, queue, readerIdx};
    }

    dispatch_async(queue, ^{
        std::string error;
        bool ok = conn->execute("BEGIN", error);
        if (!ok) {
            {
                std::lock_guard<std::mutex> lock(self->_readTxMutex);
                self->_readTxHandles.erase(txId);
                self->_readerAvailable[readerIdx] = true;
            }
            NSError *nsError = [self _errorWithMessage:error code:conn->lastErrorCode() extendedCode:conn->lastExtendedErrorCode()];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(-1, nsError);
            });
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(txId, nil);
        });
    });
}

- (void)_selectInReadTx:(int)txId
                    sql:(NSString *)sql
                 params:(NSArray *)params
              arrayMode:(BOOL)arrayMode
             completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    ReadTxHandle handle;
    {
        std::lock_guard<std::mutex> lock(_readTxMutex);
        auto it = _readTxHandles.find(txId);
        if (it == _readTxHandles.end()) {
            NSError *error = [self _errorWithMessage:"Invalid read transaction ID" code:SQLITE_MISUSE extendedCode:SQLITE_MISUSE];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(nil, nil, error);
            });
            return;
        }
        handle = it->second;
    }

    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(handle.queue, ^{
        auto result = arrayMode
            ? selectArraySQL(*handle.conn, sqlUTF8, paramsCopy)
            : selectSQL(*handle.conn, sqlUTF8, paramsCopy);
        free((void *)sqlUTF8);
        [self _dispatchSelectResult:result completion:completion];
    });
}

- (void)selectInReadTransaction:(int)txId
                            sql:(NSString *)sql
                         params:(NSArray *)params
                     completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    [self _selectInReadTx:txId sql:sql params:params arrayMode:NO completion:completion];
}

- (void)selectArrayInReadTransaction:(int)txId
                                 sql:(NSString *)sql
                              params:(NSArray *)params
                          completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    [self _selectInReadTx:txId sql:sql params:params arrayMode:YES completion:completion];
}

- (void)endReadTransaction:(int)txId
                completion:(void (^)(NSError *))completion {
    ReadTxHandle handle;
    {
        std::lock_guard<std::mutex> lock(_readTxMutex);
        auto it = _readTxHandles.find(txId);
        if (it == _readTxHandles.end()) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(nil);
            });
            return;
        }
        handle = it->second;
    }

    dispatch_async(handle.queue, ^{
        std::string error;
        handle.conn->execute("END", error);

        {
            std::lock_guard<std::mutex> lock(self->_readTxMutex);
            self->_readTxHandles.erase(txId);
            self->_readerAvailable[handle.readerIndex] = true;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            completion(nil);
        });
    });
}

// MARK: - Prepared Statements

- (void)prepare:(NSString *)sql
     completion:(void (^)(int, NSError *))completion {
    const char *sqlUTF8 = strdup([sql UTF8String]);

    dispatch_async(_writerQueue, ^{
        sqlite3_stmt *stmt = nullptr;
        int rc = sqlite3_prepare_v2(self->_writerConn.handle(), sqlUTF8, -1, &stmt, nullptr);
        free((void *)sqlUTF8);

        if (rc != SQLITE_OK) {
            NSError *error = [self _errorWithMessage:std::string(self->_writerConn.lastErrorMsg())
                                                code:self->_writerConn.lastErrorCode()
                                        extendedCode:self->_writerConn.lastExtendedErrorCode()];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(-1, error);
            });
            return;
        }

        int stmtId = self->_nextStmtId.fetch_add(1);
        {
            std::lock_guard<std::mutex> lock(self->_stmtMutex);
            self->_preparedStmts[stmtId] = {stmt, &self->_writerConn, self->_writerQueue};
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            completion(stmtId, nil);
        });
    });
}

- (void)executePrepared:(int)stmtId
                 params:(NSArray *)params
             completion:(void (^)(NSError *))completion {
    PreparedStmtHandle handle;
    {
        std::lock_guard<std::mutex> lock(_stmtMutex);
        auto it = _preparedStmts.find(stmtId);
        if (it == _preparedStmts.end()) {
            NSError *error = [self _errorWithMessage:"Invalid statement ID" code:SQLITE_MISUSE extendedCode:SQLITE_MISUSE];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(error); });
            return;
        }
        handle = it->second;
    }

    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(handle.queue, ^{
        sqlite3_reset(handle.stmt);
        sqlite3_clear_bindings(handle.stmt);

        std::string error;
        if (!bindParams(handle.stmt, paramsCopy, error)) {
            NSError *nsError = [self _errorWithMessage:error code:SQLITE_ERROR extendedCode:SQLITE_ERROR];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(nsError); });
            return;
        }

        int rc = sqlite3_step(handle.stmt);
        if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
            NSError *nsError = [self _errorWithMessage:std::string(handle.conn->lastErrorMsg())
                                                  code:handle.conn->lastErrorCode()
                                          extendedCode:handle.conn->lastExtendedErrorCode()];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(nsError); });
            return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{ completion(nil); });
    });
}

- (void)_selectPreparedImpl:(int)stmtId
                     params:(NSArray *)params
                  arrayMode:(BOOL)arrayMode
                 completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    PreparedStmtHandle handle;
    {
        std::lock_guard<std::mutex> lock(_stmtMutex);
        auto it = _preparedStmts.find(stmtId);
        if (it == _preparedStmts.end()) {
            NSError *error = [self _errorWithMessage:"Invalid statement ID" code:SQLITE_MISUSE extendedCode:SQLITE_MISUSE];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, nil, error); });
            return;
        }
        handle = it->second;
    }

    NSArray *paramsCopy = params ? [params copy] : nil;

    dispatch_async(handle.queue, ^{
        sqlite3_reset(handle.stmt);
        sqlite3_clear_bindings(handle.stmt);

        std::string bindError;
        if (!bindParams(handle.stmt, paramsCopy, bindError)) {
            NSError *nsError = [self _errorWithMessage:bindError code:SQLITE_ERROR extendedCode:SQLITE_ERROR];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, nil, nsError); });
            return;
        }

        int colCount = sqlite3_column_count(handle.stmt);
        std::vector<std::string> colNames;
        colNames.reserve(colCount);
        for (int i = 0; i < colCount; i++) {
            const char *name = sqlite3_column_name(handle.stmt, i);
            colNames.emplace_back(name ? name : "");
        }

        JSONBuilder json;
        std::vector<NSData *> blobs;
        int rc;

        if (arrayMode) {
            json.appendRaw("{\"columns\":[", 12);
            for (int i = 0; i < colCount; i++) {
                if (i > 0) json.appendRaw(',');
                json.appendString(colNames[i].c_str(), (int)colNames[i].length());
            }
            json.appendRaw("],\"rows\":[", 10);
            bool firstRow = true;
            while ((rc = sqlite3_step(handle.stmt)) == SQLITE_ROW) {
                if (!firstRow) json.appendRaw(',');
                firstRow = false;
                json.appendRaw('[');
                for (int i = 0; i < colCount; i++) {
                    if (i > 0) json.appendRaw(',');
                    appendColumnValue(handle.stmt, i, json, blobs);
                }
                json.appendRaw(']');
            }
            json.appendRaw("]}", 2);
        } else {
            json.appendRaw('[');
            bool firstRow = true;
            while ((rc = sqlite3_step(handle.stmt)) == SQLITE_ROW) {
                if (!firstRow) json.appendRaw(',');
                firstRow = false;
                json.appendRaw('{');
                for (int i = 0; i < colCount; i++) {
                    if (i > 0) json.appendRaw(',');
                    json.appendString(colNames[i].c_str(), (int)colNames[i].length());
                    json.appendRaw(':');
                    appendColumnValue(handle.stmt, i, json, blobs);
                }
                json.appendRaw('}');
            }
            json.appendRaw(']');
        }

        if (rc != SQLITE_DONE) {
            NSError *nsError = [self _errorWithMessage:std::string(handle.conn->lastErrorMsg())
                                                  code:handle.conn->lastErrorCode()
                                          extendedCode:handle.conn->lastExtendedErrorCode()];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, nil, nsError); });
            return;
        }

        NSString *jsonStr = [[NSString alloc] initWithUTF8String:json.str().c_str()];
        NSMutableArray<NSData *> *blobsArr = nil;
        if (!blobs.empty()) {
            blobsArr = [NSMutableArray arrayWithCapacity:blobs.size()];
            for (auto &b : blobs) [blobsArr addObject:b];
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            completion(jsonStr, blobsArr, nil);
        });
    });
}

- (void)selectPrepared:(int)stmtId
                params:(NSArray *)params
            completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    [self _selectPreparedImpl:stmtId params:params arrayMode:NO completion:completion];
}

- (void)selectArrayPrepared:(int)stmtId
                     params:(NSArray *)params
                 completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    [self _selectPreparedImpl:stmtId params:params arrayMode:YES completion:completion];
}

- (void)finalizePrepared:(int)stmtId
              completion:(void (^)(NSError *))completion {
    PreparedStmtHandle handle;
    {
        std::lock_guard<std::mutex> lock(_stmtMutex);
        auto it = _preparedStmts.find(stmtId);
        if (it == _preparedStmts.end()) {
            dispatch_async(dispatch_get_main_queue(), ^{ completion(nil); });
            return;
        }
        handle = it->second;
        _preparedStmts.erase(it);
    }

    dispatch_async(handle.queue, ^{
        sqlite3_finalize(handle.stmt);
        dispatch_async(dispatch_get_main_queue(), ^{ completion(nil); });
    });
}

// MARK: - Sync Operations

- (BOOL)_ensureSyncConn:(NSError **)error {
    if (_syncConnOpened) return YES;

    std::string err;
    int flags = _readOnly
        ? (SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX)
        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX);

    if (!_syncConn.open(_path, flags, _busyTimeoutMs, err)) {
        if (error) *error = [self _errorWithMessage:err code:SQLITE_CANTOPEN extendedCode:SQLITE_CANTOPEN];
        return NO;
    }
    if (!_readOnly) {
        _syncConn.configureWAL(err);
    }
    _syncConnOpened = true;
    return YES;
}

- (BOOL)executeSync:(NSString *)sql
             params:(NSArray *)params
              error:(NSError **)error {
    if (![self _ensureSyncConn:error]) return NO;

    auto result = executeSQL(_syncConn, [sql UTF8String], params);
    if (!result.success) {
        if (error) *error = [self _errorWithMessage:result.error code:result.errorCode extendedCode:result.extendedErrorCode];
        return NO;
    }
    return YES;
}

- (NSString *)selectSync:(NSString *)sql
                  params:(NSArray *)params
                   error:(NSError **)error {
    if (![self _ensureSyncConn:error]) return nil;

    auto result = selectSQL(_syncConn, [sql UTF8String], params);
    if (!result.success) {
        if (error) *error = [self _errorWithMessage:result.error code:result.errorCode extendedCode:result.extendedErrorCode];
        return nil;
    }
    return [[NSString alloc] initWithUTF8String:result.json.c_str()];
}

- (NSString *)selectArraySync:(NSString *)sql
                       params:(NSArray *)params
                        error:(NSError **)error {
    if (![self _ensureSyncConn:error]) return nil;

    auto result = selectArraySQL(_syncConn, [sql UTF8String], params);
    if (!result.success) {
        if (error) *error = [self _errorWithMessage:result.error code:result.errorCode extendedCode:result.extendedErrorCode];
        return nil;
    }
    return [[NSString alloc] initWithUTF8String:result.json.c_str()];
}

// MARK: - Close

- (void)close {
    if (!_isOpen) return;
    _isOpen = NO;

    {
        std::lock_guard<std::mutex> lock(_stmtMutex);
        for (auto &pair : _preparedStmts) {
            sqlite3_finalize(pair.second.stmt);
        }
        _preparedStmts.clear();
    }

    {
        std::lock_guard<std::mutex> lock(_readTxMutex);
        for (auto &pair : _readTxHandles) {
            std::string err;
            pair.second.conn->execute("END", err);
        }
        _readTxHandles.clear();
    }

    dispatch_sync(_writerQueue, ^{
        self->_writerConn.close();
    });

    for (size_t i = 0; i < _readerConns.size(); i++) {
        dispatch_sync(_readerQueues[i], ^{
            self->_readerConns[i]->close();
            delete self->_readerConns[i];
        });
    }
    _readerConns.clear();
    _readerQueues.clear();

    if (_syncConnOpened) {
        _syncConn.close();
        _syncConnOpened = false;
    }
}

- (void)dealloc {
    [self close];
}

// MARK: - Error Helpers

- (NSError *)_errorWithMessage:(const std::string &)message
                          code:(int)code
                  extendedCode:(int)extendedCode {
    NSString *msg = [NSString stringWithUTF8String:message.c_str()];
    return [NSError errorWithDomain:@"NSSQLiteDatabase"
                               code:code
                           userInfo:@{
                               NSLocalizedDescriptionKey: msg,
                               @"extendedCode": @(extendedCode)
                           }];
}

@end
