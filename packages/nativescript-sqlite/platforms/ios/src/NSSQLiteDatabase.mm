#import "NSSQLiteDatabase.h"
#include <sqlite3.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <thread>
#include <cstring>

// MARK: - Open Failure

/// A failed step of opening a connection, captured before the handle is closed.
struct OpenFailure {
    int code = SQLITE_OK;
    int extendedCode = SQLITE_OK;
    std::string message;
};

/// sqlite3_extended_result_codes is on for every connection, so the codes SQLite
/// hands back are already extended; the primary code is their low byte.
static inline int primaryCode(int code) { return code & 0xFF; }

// MARK: - Encryption Key

/**
 * Renders the key as the operand of `PRAGMA key`, doubling any embedded quote
 * so a key containing one can neither break the statement nor inject into it.
 *
 * SQLCipher's raw-key form — x'<64 hex>', or 96 hex to carry the salt — needs
 * no special case: the codec recognises it from the string *value*, so it must
 * arrive as ordinary quoted text like any other key. Emitting it unquoted
 * would instead be a blob literal, which PRAGMA does not accept at all.
 */
static std::string encryptionKeyLiteral(const std::string &key) {
    std::string literal;
    literal.reserve(key.size() + 2);
    literal.push_back('\'');
    for (char c : key) {
        if (c == '\'') literal.push_back('\'');
        literal.push_back(c);
    }
    literal.push_back('\'');
    return literal;
}

/// Stands in for a message that quoted the key back.
static const char *const kKeyStepFailedMessage = "the encryption key could not be applied";

// MARK: - Open Sequence

/// The numbers are the wire format the JS layer sends; it resolves and validates
/// the whole sequence, so a connection runs the list as given.
enum class OpenStepKind : uint8_t {
    Sql = 0,  ///< run OpenStep::sql
    Key = 1,  ///< apply ConnectionOpenOptions::encryptionKey
    Wal = 2,  ///< switch the journal mode to WAL
};

enum class OpenStepScope : uint8_t {
    All = 0,
    Writer = 1,
    Readers = 2,
};

struct OpenStep {
    OpenStepKind kind = OpenStepKind::Sql;
    OpenStepScope scope = OpenStepScope::All;
    std::string sql;
};

/// One connection's setup. `isWriter` carries the role on its own because
/// `queryOnly` cannot stand in for it: readers of a read-only database get no
/// `PRAGMA query_only`, yet still have to skip the writer's steps.
struct ConnectionOpenOptions {
    std::string path;
    int flags = 0;
    int busyTimeoutMs = 0;
    /// Operand of PRAGMA key, already resolved by the JS layer — the connection
    /// quotes it but never reinterprets it.
    std::string encryptionKey;
    bool isWriter = true;
    bool readOnly = false;
    bool queryOnly = false;  ///< PRAGMA query_only=ON, after the sequence
};

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
        static const char prefix[] = "{\"__blob__\":";
        buf_.append(prefix, sizeof(prefix) - 1);
        appendInt(index);
        buf_.push_back('}');
    }
};

// MARK: - SQLite Connection

class SQLiteConnection {
    sqlite3 *db_ = nullptr;
    std::string path_;
    OpenFailure failure_;
    bool failed_ = false;

public:
    SQLiteConnection() = default;
    ~SQLiteConnection() { close(); }

    SQLiteConnection(const SQLiteConnection &) = delete;
    SQLiteConnection &operator=(const SQLiteConnection &) = delete;

    sqlite3 *handle() const { return db_; }

    /**
     * Non-null while the connection could not be opened. Every error the
     * connection reports then describes that failure instead of the missing
     * handle, so work routed to a connection that never opened — a pooled
     * reader, or anything at all under asyncOpen — says why.
     */
    const OpenFailure *openFailure() const { return failed_ ? &failure_ : nullptr; }

    void recordOpenFailure(const OpenFailure &failure) {
        failure_ = failure;
        failed_ = true;
    }

    bool open(const ConnectionOpenOptions &opts, const std::vector<OpenStep> &sequence, OpenFailure &outError) {
        if (!openConnection(opts, sequence, outError)) {
            recordOpenFailure(outError);
            return false;
        }
        failed_ = false;
        return true;
    }

private:
    bool openConnection(const ConnectionOpenOptions &opts, const std::vector<OpenStep> &sequence, OpenFailure &outError) {
        int rc = sqlite3_open_v2(opts.path.c_str(), &db_, opts.flags, nullptr);
        if (rc != SQLITE_OK) {
            // sqlite3_open_v2 still hands back a handle on most failures, and the
            // message only lives on that handle — so read it before closing.
            outError.code = primaryCode(rc);
            outError.extendedCode = db_ ? sqlite3_extended_errcode(db_) : rc;
            outError.message = db_ ? sqlite3_errmsg(db_) : "out of memory allocating the database handle";
            if (db_) { sqlite3_close(db_); db_ = nullptr; }
            return false;
        }
        path_ = opts.path;
        sqlite3_extended_result_codes(db_, 1);
        sqlite3_busy_timeout(db_, opts.busyTimeoutMs);

        // The order is the caller's, and SQLite constrains it: the key has to
        // precede anything that reads the database, which is also why
        // sqlite3_auto_extension cannot stand in for these statements — an
        // auto-extension runs inside sqlite3_open_v2, before any key is applied.
        //
        // A step skipped by scope keeps its index, so the index a failure reports
        // is the one the caller wrote.
        for (size_t i = 0; i < sequence.size(); i++) {
            const OpenStep &step = sequence[i];
            if (step.scope == OpenStepScope::Writer && !opts.isWriter) continue;
            if (step.scope == OpenStepScope::Readers && opts.isWriter) continue;

            const std::string what = "open step " + std::to_string(i);
            switch (step.kind) {
                case OpenStepKind::Sql:
                    if (step.sql.empty()) continue;
                    if (!runOpenStatement(what, step.sql.c_str(), nullptr, outError)) return false;
                    break;

                case OpenStepKind::Key: {
                    if (opts.encryptionKey.empty()) continue;
                    const std::string pragmaSQL = "PRAGMA key = " + encryptionKeyLiteral(opts.encryptionKey);
                    if (!runOpenStatement(what, pragmaSQL.c_str(), &opts.encryptionKey, outError)) return false;
                    break;
                }

                case OpenStepKind::Wal:
                    if (!opts.isWriter || opts.readOnly) continue;
                    if (!runOpenStatement(what, "PRAGMA journal_mode=WAL", nullptr, outError)) return false;
                    break;
            }
        }

        // Not part of the sequence: a reader stays a reader whatever the caller asked for.
        if (opts.queryOnly && !runOpenStatement("query_only", "PRAGMA query_only=ON", nullptr, outError)) {
            return false;
        }

        return true;
    }

    bool runOpenStatement(const std::string &what, const char *sql, const std::string *secret, OpenFailure &outError) {
        if (execPragma(sql, outError)) return true;
        // SQLite quotes the offending token back in a few of its messages, and the
        // key is one thing that may never be quoted back.
        if (secret && !secret->empty() && outError.message.find(*secret) != std::string::npos) {
            outError.message = kKeyStepFailedMessage;
        }
        outError.message = what + " failed: " + outError.message;
        close();
        return false;
    }

public:
    void close() {
        if (db_) {
            sqlite3_close_v2(db_);
            db_ = nullptr;
        }
    }

    int lastErrorCode() const { return failed_ ? failure_.code : (db_ ? primaryCode(sqlite3_errcode(db_)) : SQLITE_ERROR); }
    int lastExtendedErrorCode() const { return failed_ ? failure_.extendedCode : (db_ ? sqlite3_extended_errcode(db_) : SQLITE_ERROR); }
    const char *lastErrorMsg() const { return failed_ ? failure_.message.c_str() : (db_ ? sqlite3_errmsg(db_) : "Database not open"); }

    bool execute(const char *sql, std::string &outError) {
        if (failed_) {
            outError = failure_.message;
            return false;
        }
        char *errMsg = nullptr;
        int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &errMsg);
        if (rc != SQLITE_OK) {
            outError = errMsg ? errMsg : lastErrorMsg();
            if (errMsg) sqlite3_free(errMsg);
            return false;
        }
        return true;
    }

private:
    bool execPragma(const char *sql, OpenFailure &outError) {
        char *errMsg = nullptr;
        int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &errMsg);
        if (rc != SQLITE_OK) {
            outError.code = primaryCode(rc);
            outError.extendedCode = sqlite3_extended_errcode(db_);
            outError.message = errMsg ? errMsg : sqlite3_errmsg(db_);
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

// MARK: - Sync Target

/**
 * Where a synchronous call runs. A nil queue means the calling thread already
 * owns the connection — it holds a transactionSync span, which keeps the writer
 * queue suspended — so the work runs inline; dispatching there would deadlock.
 */
struct SyncTarget {
    SQLiteConnection *conn = nullptr;
    dispatch_queue_t queue = nil;
    bool valid = false;
};

static void runSync(const SyncTarget &target, dispatch_block_t block) {
    if (target.queue) {
        dispatch_sync(target.queue, block);
    } else {
        block();
    }
}

// MARK: - NSSQLiteDatabase Implementation

/// The wording every sync write sees while an asynchronous transaction is open.
static const char *const kActiveWriteTxMessage =
    "a transaction is active on this database; use the transaction object's executeSync, or pass { joinTransaction: true } to run inside it";

@implementation NSSQLiteDatabase {
    SQLiteConnection _writerConn;
    std::vector<SQLiteConnection *> _readerConns;

    dispatch_queue_t _writerQueue;
    std::vector<dispatch_queue_t> _readerQueues;
    std::atomic<int> _readerIndex;

    std::string _path;
    std::string _encryptionKey;
    std::vector<OpenStep> _openSequence;
    int _busyTimeoutMs;
    BOOL _readOnly;
    BOOL _isOpen;
    bool _serialized;

    std::atomic<int> _nextTxId;
    std::atomic<int> _nextStmtId;

    std::mutex _initMutex;
    int _pendingOpens;
    NSError *_openError;
    NSMutableArray *_initCompletions;
    dispatch_group_t _writerOpenGroup;
    std::atomic<bool> _writerOpenFailed;
    OpenFailure _writerOpenFailure;

    std::mutex _txMutex;
    bool _hasActiveWriteTx;
    int _activeWriteTxId;
    int _syncTxId;
    bool _writerQueueSuspended;
    std::thread::id _syncTxThread;
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
                 busyTimeout:(int)busyTimeoutMs
               encryptionKey:(NSString *)encryptionKey
                openSequence:(NSArray<NSDictionary<NSString *, id> *> *)openSequence
                  serialized:(BOOL)serialized
                   asyncOpen:(BOOL)asyncOpen
                       error:(NSError **)error {
    NSSQLiteDatabase *db = [[NSSQLiteDatabase alloc] init];
    if (![db _openWithPath:path poolSize:poolSize readOnly:readOnly busyTimeout:busyTimeoutMs encryptionKey:encryptionKey openSequence:openSequence serialized:serialized asyncOpen:asyncOpen error:error]) {
        return nil;
    }
    return db;
}

- (BOOL)_openWithPath:(NSString *)path
             poolSize:(int)poolSize
             readOnly:(BOOL)readOnly
          busyTimeout:(int)busyTimeoutMs
        encryptionKey:(NSString *)encryptionKey
         openSequence:(NSArray<NSDictionary<NSString *, id> *> *)openSequence
           serialized:(BOOL)serialized
            asyncOpen:(BOOL)asyncOpen
                error:(NSError **)error {
    _serialized = serialized;
    _path = [path UTF8String];
    _busyTimeoutMs = busyTimeoutMs;
    _readOnly = readOnly;
    _encryptionKey = encryptionKey ? [encryptionKey UTF8String] : "";
    // Read once, into plain values: the sequence outlives this call on queues the
    // JS side never touches.
    _openSequence.clear();
    _openSequence.reserve(openSequence.count);
    for (NSDictionary<NSString *, id> *entry in openSequence) {
        OpenStep step;
        step.kind = (OpenStepKind)[entry[@"kind"] intValue];
        step.scope = (OpenStepScope)[entry[@"scope"] intValue];
        NSString *sql = entry[@"sql"];
        if ([sql isKindOfClass:[NSString class]]) step.sql = [sql UTF8String];
        _openSequence.push_back(std::move(step));
    }
    _writerOpenFailed.store(false, std::memory_order_relaxed);
    _readerIndex = 0;
    _nextTxId = 1;
    _nextStmtId = 1;
    _hasActiveWriteTx = false;
    _activeWriteTxId = -1;
    _syncTxId = -1;
    _writerQueueSuspended = false;

    if (poolSize < 1) poolSize = 1;
    // Serialized mode: no reader pool. All reads, writes, transactions and sync
    // operations run on the single writer connection via _writerQueue.
    int readerCount = serialized ? 0 : poolSize;
    _pendingOpens = 1 + readerCount;

    NSString *writerLabel = [NSString stringWithFormat:@"com.nssqlite.writer.%@", [path lastPathComponent]];
    _writerQueue = dispatch_queue_create([writerLabel UTF8String], DISPATCH_QUEUE_SERIAL);

    // Only the writer is opened with SQLITE_OPEN_CREATE, so a reader that starts
    // first on a database that does not exist yet fails with SQLITE_CANTOPEN.
    _writerOpenGroup = dispatch_group_create();
    dispatch_group_enter(_writerOpenGroup);

    // Every slot exists before any open runs, so the open blocks and close can
    // index into these vectors without them ever being resized underneath.
    for (int i = 0; i < readerCount; i++) {
        _readerConns.push_back(new SQLiteConnection());
        _readerAvailable.push_back(true);
        NSString *label = [NSString stringWithFormat:@"com.nssqlite.reader.%d.%@", i, [path lastPathComponent]];
        _readerQueues.push_back(dispatch_queue_create([label UTF8String], DISPATCH_QUEUE_SERIAL));
    }

    _isOpen = YES;

    if (asyncOpen) {
        dispatch_async(_writerQueue, ^{ [self _openWriter:nullptr]; });
    } else {
        OpenFailure failure;
        if (![self _openWriter:&failure]) {
            // Nothing has been dispatched yet, so the half-built database can be
            // torn down here rather than left for -dealloc.
            _isOpen = NO;
            for (auto *reader : _readerConns) delete reader;
            _readerConns.clear();
            _readerQueues.clear();
            _readerAvailable.clear();
            if (error) *error = [self _errorFromOpenFailure:failure];
            return NO;
        }
    }

    for (int i = 0; i < readerCount; i++) {
        dispatch_async(_readerQueues[i], ^{ [self _openReaderAtIndex:i]; });
    }
    return YES;
}

/// Opens the writer. Reports the failure through outFailure for the synchronous
/// path; nullptr is the asyncOpen path, where only initializedWithCompletion:
/// is left to report it.
- (BOOL)_openWriter:(OpenFailure *)outFailure {
    OpenFailure failure;

    // SQLITE_OPEN_URI is always safe to set: SQLite only applies URI parsing to
    // filenames that begin with "file:" (e.g. "file:/db?vfs=memdb"); any other
    // path — even one containing "?" — is treated as an ordinary filename.
    int flags = (_readOnly
        ? (SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX)
        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX)) | SQLITE_OPEN_URI;

    ConnectionOpenOptions opts;
    opts.path = _path;
    opts.flags = flags;
    opts.busyTimeoutMs = _busyTimeoutMs;
    opts.encryptionKey = _encryptionKey;
    opts.isWriter = true;
    opts.readOnly = _readOnly;

    BOOL ok = _writerConn.open(opts, _openSequence, failure);
    if (!ok) {
        NSLog(@"[NSSQLiteDatabase] Failed to open writer: %s", failure.message.c_str());
        _writerOpenFailure = failure;
        if (outFailure) *outFailure = failure;
    }

    // The verdict the readers act on, published before they are let through.
    _writerOpenFailed.store(!ok, std::memory_order_release);
    dispatch_group_leave(_writerOpenGroup);
    [self _connectionOpenFinished:ok ? nil : [self _errorFromOpenFailure:failure]];
    return ok;
}

- (void)_openReaderAtIndex:(int)index {
    dispatch_group_wait(_writerOpenGroup, DISPATCH_TIME_FOREVER);
    SQLiteConnection *reader = _readerConns[index];

    // A reader never touches a file the writer could not set up. It takes on the
    // writer's failure so that work routed here still says why the database is
    // unusable, rather than that it is closed.
    if (_writerOpenFailed.load(std::memory_order_acquire)) {
        reader->recordOpenFailure(_writerOpenFailure);
        [self _connectionOpenFinished:[self _errorFromOpenFailure:_writerOpenFailure]];
        return;
    }

    // Readers open as READWRITE so they can initialize WAL shared memory (SHM).
    // READONLY connections cannot create/map the SHM file, which causes "unable to
    // open database file" errors when the DB is already in WAL mode.
    // PRAGMA query_only=ON prevents accidental writes through these connections.
    int flags = (_readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE) | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_URI;

    ConnectionOpenOptions opts;
    opts.path = _path;
    opts.flags = flags;
    opts.busyTimeoutMs = _busyTimeoutMs;
    opts.encryptionKey = _encryptionKey;
    opts.isWriter = false;
    opts.readOnly = _readOnly;
    opts.queryOnly = !_readOnly;

    OpenFailure failure;
    if (!reader->open(opts, _openSequence, failure)) {
        NSLog(@"[NSSQLiteDatabase] Failed to open reader %d: %s", index, failure.message.c_str());
        [self _connectionOpenFinished:[self _errorFromOpenFailure:failure]];
        return;
    }
    [self _connectionOpenFinished:nil];
}

- (void)_connectionOpenFinished:(NSError *)error {
    NSMutableArray *completions = nil;
    NSError *result = nil;
    {
        std::lock_guard<std::mutex> lock(_initMutex);
        if (error && !_openError) _openError = error;
        if (--_pendingOpens == 0) {
            completions = _initCompletions;
            _initCompletions = nil;
            result = _openError;
        }
    }
    for (void (^completion)(NSError *) in completions) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(result); });
    }
}

- (void)initializedWithCompletion:(void (^)(NSError *))completion {
    if (!completion) return;
    NSError *result = nil;
    {
        std::lock_guard<std::mutex> lock(_initMutex);
        if (_pendingOpens > 0) {
            if (!_initCompletions) _initCompletions = [NSMutableArray array];
            [_initCompletions addObject:[completion copy]];
            return;
        }
        result = _openError;
    }
    dispatch_async(dispatch_get_main_queue(), ^{ completion(result); });
}

- (NSError *)_errorFromOpenFailure:(const OpenFailure &)failure {
    return [self _errorWithMessage:failure.message code:failure.code extendedCode:failure.extendedCode];
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
    // Serialized mode (or an empty pool): run reads on the writer connection.
    if (_serialized || _readerQueues.empty()) {
        [self _selectOnWriter:sql params:params arrayMode:NO completion:completion];
        return;
    }
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
    // Serialized mode (or an empty pool): run reads on the writer connection.
    if (_serialized || _readerQueues.empty()) {
        [self _selectOnWriter:sql params:params arrayMode:YES completion:completion];
        return;
    }
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

/// Callers hold _txMutex, which is what makes assigning _activeWriteTxId here safe.
- (void)_startTransaction:(const std::string &)beginSQL
               completion:(void (^)(int, NSError *))completion {
    int txId = _nextTxId.fetch_add(1);
    _activeWriteTxId = txId;
    std::string sql = beginSQL;

    dispatch_async(_writerQueue, ^{
        std::string error;
        bool ok = self->_writerConn.execute(sql.c_str(), error);
        if (!ok) {
            {
                std::lock_guard<std::mutex> lock(self->_txMutex);
                self->_hasActiveWriteTx = false;
                self->_activeWriteTxId = -1;
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

/// Valid while the BEGIN..COMMIT span is open, whether that span is driven
/// asynchronously or by beginTransactionSync:error:.
- (BOOL)_isWriteTxId:(int)txId {
    if (txId < 0) return NO;
    std::lock_guard<std::mutex> lock(_txMutex);
    return txId == _activeWriteTxId || txId == _syncTxId;
}

- (NSError *)_invalidWriteTxError {
    return [self _errorWithMessage:"Invalid transaction ID" code:SQLITE_MISUSE extendedCode:SQLITE_MISUSE];
}

- (void)executeInTransaction:(int)txId
                         sql:(NSString *)sql
                      params:(NSArray *)params
                  completion:(void (^)(NSError *))completion {
    if (![self _isWriteTxId:txId]) {
        NSError *error = [self _invalidWriteTxError];
        if (completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(error); });
        return;
    }

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
    if (![self _isWriteTxId:txId]) {
        NSError *error = [self _invalidWriteTxError];
        if (completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, nil, error); });
        return;
    }
    [self _selectOnWriter:sql params:params arrayMode:NO completion:completion];
}

- (void)selectArrayInTransaction:(int)txId
                             sql:(NSString *)sql
                          params:(NSArray *)params
                      completion:(void (^)(NSString *, NSArray<NSData *> *, NSError *))completion {
    if (![self _isWriteTxId:txId]) {
        NSError *error = [self _invalidWriteTxError];
        if (completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, nil, error); });
        return;
    }
    [self _selectOnWriter:sql params:params arrayMode:YES completion:completion];
}

- (void)commitTransaction:(int)txId
               completion:(void (^)(NSError *))completion {
    dispatch_async(_writerQueue, ^{
        std::string error;
        bool ok = self->_writerConn.execute("COMMIT", error);
        int code = self->_writerConn.lastErrorCode();
        int extendedCode = self->_writerConn.lastExtendedErrorCode();
        if (!ok) {
            // A failed COMMIT leaves the transaction open, and the next queued
            // write would silently join it.
            std::string rollbackError;
            self->_writerConn.execute("ROLLBACK", rollbackError);
        }
        {
            std::lock_guard<std::mutex> lock(self->_txMutex);
            self->_hasActiveWriteTx = false;
            if (self->_activeWriteTxId == txId) self->_activeWriteTxId = -1;
        }
        NSError *nsError = ok ? nil : [self _errorWithMessage:error code:code extendedCode:extendedCode];
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
        bool ok = self->_writerConn.execute("ROLLBACK", error);
        NSError *nsError = ok ? nil : [self _errorWithMessage:error
                                                         code:self->_writerConn.lastErrorCode()
                                                 extendedCode:self->_writerConn.lastExtendedErrorCode()];
        {
            std::lock_guard<std::mutex> lock(self->_txMutex);
            self->_hasActiveWriteTx = false;
            if (self->_activeWriteTxId == txId) self->_activeWriteTxId = -1;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(nsError);
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
    // Serialized mode: there is no reader pool. A read transaction becomes a
    // regular deferred transaction on the single connection, gated so it never
    // overlaps a write transaction.
    if (_serialized) {
        [self beginTransaction:@"DEFERRED" completion:completion];
        return;
    }

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
    // Serialized mode: the read transaction is an ordinary transaction on the
    // single connection, so just run the select on the writer queue.
    if (_serialized) {
        [self _selectOnWriter:sql params:params arrayMode:arrayMode completion:completion];
        return;
    }

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
    // Serialized mode: end the underlying transaction (COMMIT is a no-op for a
    // read-only transaction) and release the gate for any queued transaction.
    if (_serialized) {
        [self commitTransaction:txId completion:completion];
        return;
    }

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

/// The writer, unless this thread is inside a transactionSync span it opened.
- (SyncTarget)_writerSyncTarget {
    SyncTarget target;
    target.conn = &_writerConn;
    target.valid = true;
    std::lock_guard<std::mutex> lock(_txMutex);
    if (_syncTxId < 0 || _syncTxThread != std::this_thread::get_id()) {
        target.queue = _writerQueue;
    }
    return target;
}

- (SyncTarget)_syncTargetForTxId:(int)txId {
    SyncTarget target;
    if (txId < 0) return target;
    {
        std::lock_guard<std::mutex> lock(_txMutex);
        if (txId == _syncTxId) {
            // Only the thread holding the span may drive its connection; any
            // other thread would have to wait for a span that is already over.
            if (_syncTxThread != std::this_thread::get_id()) return target;
            target.conn = &_writerConn;
            target.valid = true;
            return target;
        }
        if (txId == _activeWriteTxId) {
            target.conn = &_writerConn;
            target.queue = _writerQueue;
            target.valid = true;
            return target;
        }
    }
    std::lock_guard<std::mutex> lock(_readTxMutex);
    auto it = _readTxHandles.find(txId);
    if (it != _readTxHandles.end()) {
        target.conn = it->second.conn;
        target.queue = it->second.queue;
        target.valid = true;
    }
    return target;
}

- (BOOL)_executeSyncOnTarget:(const SyncTarget &)target
                         sql:(NSString *)sql
                      params:(NSArray *)params
                       error:(NSError **)error {
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;
    SQLiteConnection *conn = target.conn;
    ExecuteResult result{};
    ExecuteResult *out = &result;
    runSync(target, ^{ *out = executeSQL(*conn, sqlUTF8, paramsCopy); });
    free((void *)sqlUTF8);

    if (!result.success) {
        if (error) *error = [self _errorWithMessage:result.error code:result.errorCode extendedCode:result.extendedErrorCode];
        return NO;
    }
    return YES;
}

- (NSString *)_selectSyncOnTarget:(const SyncTarget &)target
                              sql:(NSString *)sql
                           params:(NSArray *)params
                        arrayMode:(BOOL)arrayMode
                            blobs:(NSArray<NSData *> **)outBlobs
                            error:(NSError **)error {
    const char *sqlUTF8 = strdup([sql UTF8String]);
    NSArray *paramsCopy = params ? [params copy] : nil;
    SQLiteConnection *conn = target.conn;
    SelectResult result{};
    SelectResult *out = &result;
    runSync(target, ^{
        *out = arrayMode ? selectArraySQL(*conn, sqlUTF8, paramsCopy)
                         : selectSQL(*conn, sqlUTF8, paramsCopy);
    });
    free((void *)sqlUTF8);

    if (!result.success) {
        if (error) *error = [self _errorWithMessage:result.error code:result.errorCode extendedCode:result.extendedErrorCode];
        return nil;
    }
    if (outBlobs && !result.blobs.empty()) {
        NSMutableArray<NSData *> *blobs = [NSMutableArray arrayWithCapacity:result.blobs.size()];
        for (auto &b : result.blobs) [blobs addObject:b];
        *outBlobs = blobs;
    }
    return [[NSString alloc] initWithUTF8String:result.json.c_str()];
}

- (BOOL)executeSync:(NSString *)sql
             params:(NSArray *)params
    joinTransaction:(BOOL)joinTransaction
              error:(NSError **)error {
    SyncTarget target = [self _writerSyncTarget];

    // The safeguard is about silently joining a transaction the writer queue
    // owns. A span this thread already holds cannot be joined by accident, and
    // nothing asynchronous can run inside it, so it is exempt.
    if (!joinTransaction && target.queue) {
        std::lock_guard<std::mutex> lock(_txMutex);
        if (_hasActiveWriteTx) {
            if (error) *error = [self _errorWithMessage:kActiveWriteTxMessage code:SQLITE_BUSY extendedCode:SQLITE_BUSY];
            return NO;
        }
    }

    return [self _executeSyncOnTarget:target sql:sql params:params error:error];
}

- (NSString *)selectSync:(NSString *)sql
                  params:(NSArray *)params
                   blobs:(NSArray<NSData *> **)outBlobs
                   error:(NSError **)error {
    return [self _selectSyncOnTarget:[self _writerSyncTarget] sql:sql params:params arrayMode:NO blobs:outBlobs error:error];
}

- (NSString *)selectArraySync:(NSString *)sql
                       params:(NSArray *)params
                        blobs:(NSArray<NSData *> **)outBlobs
                        error:(NSError **)error {
    return [self _selectSyncOnTarget:[self _writerSyncTarget] sql:sql params:params arrayMode:YES blobs:outBlobs error:error];
}

// MARK: - Sync Operations Inside a Transaction

- (BOOL)executeInTransactionSync:(int)txId
                             sql:(NSString *)sql
                          params:(NSArray *)params
                           error:(NSError **)error {
    SyncTarget target = [self _syncTargetForTxId:txId];
    if (!target.valid) {
        if (error) *error = [self _invalidWriteTxError];
        return NO;
    }
    return [self _executeSyncOnTarget:target sql:sql params:params error:error];
}

- (NSString *)selectInTransactionSync:(int)txId
                                  sql:(NSString *)sql
                               params:(NSArray *)params
                                blobs:(NSArray<NSData *> **)outBlobs
                                error:(NSError **)error {
    SyncTarget target = [self _syncTargetForTxId:txId];
    if (!target.valid) {
        if (error) *error = [self _invalidWriteTxError];
        return nil;
    }
    return [self _selectSyncOnTarget:target sql:sql params:params arrayMode:NO blobs:outBlobs error:error];
}

- (NSString *)selectArrayInTransactionSync:(int)txId
                                       sql:(NSString *)sql
                                    params:(NSArray *)params
                                     blobs:(NSArray<NSData *> **)outBlobs
                                     error:(NSError **)error {
    SyncTarget target = [self _syncTargetForTxId:txId];
    if (!target.valid) {
        if (error) *error = [self _invalidWriteTxError];
        return nil;
    }
    return [self _selectSyncOnTarget:target sql:sql params:params arrayMode:YES blobs:outBlobs error:error];
}

// MARK: - Synchronous Transaction Span

- (int)beginTransactionSync:(NSString *)behavior
                      error:(NSError **)error {
    std::string beginSQL = "BEGIN";
    if (behavior && behavior.length > 0) {
        beginSQL += " ";
        beginSQL += [behavior UTF8String];
    }

    {
        std::lock_guard<std::mutex> lock(_txMutex);
        if (_hasActiveWriteTx) {
            if (error) *error = [self _errorWithMessage:kActiveWriteTxMessage code:SQLITE_BUSY extendedCode:SQLITE_BUSY];
            return -1;
        }
        if (_syncTxId >= 0) {
            if (error) *error = [self _errorWithMessage:"a synchronous transaction is already active on this database"
                                                   code:SQLITE_MISUSE extendedCode:SQLITE_MISUSE];
            return -1;
        }
    }

    // Suspending from inside the drain block is what makes the span exclusive:
    // everything queued earlier has finished, and nothing queued later — including
    // anything dispatched from inside the span — runs before the resume.
    dispatch_sync(_writerQueue, ^{ dispatch_suspend(self->_writerQueue); });

    int txId = _nextTxId.fetch_add(1);
    {
        std::lock_guard<std::mutex> lock(_txMutex);
        _syncTxId = txId;
        _syncTxThread = std::this_thread::get_id();
        _writerQueueSuspended = true;
    }

    std::string err;
    if (!_writerConn.execute(beginSQL.c_str(), err)) {
        if (error) *error = [self _errorWithMessage:err
                                               code:_writerConn.lastErrorCode()
                                       extendedCode:_writerConn.lastExtendedErrorCode()];
        [self _endSyncTx:txId commit:NO error:NULL];
        return -1;
    }
    return txId;
}

- (BOOL)endTransactionSync:(int)txId
                    commit:(BOOL)commit
                     error:(NSError **)error {
    return [self _endSyncTx:txId commit:commit error:error];
}

- (BOOL)_endSyncTx:(int)txId
            commit:(BOOL)commit
             error:(NSError **)error {
    {
        std::lock_guard<std::mutex> lock(_txMutex);
        // An id that is not the open span has already been ended; ending twice
        // must not resume the queue twice.
        if (txId < 0 || txId != _syncTxId) return YES;
        _syncTxId = -1;
        _syncTxThread = std::thread::id();
    }

    std::string err;
    bool ok = _writerConn.execute(commit ? "COMMIT" : "ROLLBACK", err);
    int code = _writerConn.lastErrorCode();
    int extendedCode = _writerConn.lastExtendedErrorCode();
    if (!ok && commit) {
        // A failed COMMIT leaves the transaction open, and the queue is about to
        // be resumed onto it.
        std::string rollbackError;
        _writerConn.execute("ROLLBACK", rollbackError);
    }

    // Resuming before the error is reported is what keeps a failing COMMIT, a
    // throw or a closed database from leaving the queue held forever.
    {
        std::lock_guard<std::mutex> lock(_txMutex);
        if (_writerQueueSuspended) {
            _writerQueueSuspended = false;
            dispatch_resume(_writerQueue);
        }
    }

    if (!ok && commit) {
        if (error) *error = [self _errorWithMessage:err code:code extendedCode:extendedCode];
        return NO;
    }
    return YES;
}

- (void)_endAnyOpenSyncTx {
    int txId;
    {
        std::lock_guard<std::mutex> lock(_txMutex);
        txId = _syncTxId;
    }
    if (txId >= 0) [self _endSyncTx:txId commit:NO error:NULL];
}

// MARK: - Runtime Info

- (NSDictionary<NSString *, id> *)runtimeInfo {
    NSMutableArray<NSString *> *compileOptions = [NSMutableArray array];
    // An app may link a SQLite built without the compile-option diagnostics; the
    // symbol then does not exist and referencing it breaks the link.
#ifndef SQLITE_OMIT_COMPILEOPTION_DIAGS
    for (int i = 0; ; i++) {
        const char *option = sqlite3_compileoption_get(i);
        if (!option) break;
        [compileOptions addObject:[NSString stringWithUTF8String:option]];
    }
#endif
    return @{
        @"version": [NSString stringWithUTF8String:sqlite3_libversion()],
        @"sourceId": [NSString stringWithUTF8String:sqlite3_sourceid()],
        @"compileOptions": compileOptions
    };
}

// MARK: - Close

- (void)closeWithCompletion:(void (^)(void))completion {
    if (!_isOpen) {
        if (completion) {
            dispatch_async(dispatch_get_main_queue(), ^{ completion(); });
        }
        return;
    }
    _isOpen = NO;

    // A held writer queue would never drain, so the drain below would hang.
    [self _endAnyOpenSyncTx];

    // Reject pending queued transactions
    {
        std::lock_guard<std::mutex> lock(_txMutex);
        for (auto &pending : _pendingTxStarts) {
            auto cb = pending.second;
            NSError *error = [self _errorWithMessage:"Database is closing" code:SQLITE_MISUSE extendedCode:SQLITE_MISUSE];
            dispatch_async(dispatch_get_main_queue(), ^{
                cb(-1, error);
            });
        }
        _pendingTxStarts.clear();
        _hasActiveWriteTx = false;
        _activeWriteTxId = -1;
    }

    dispatch_group_t group = dispatch_group_create();

    // Drain writer queue: rollback active tx if any, finalize statements, close connection
    dispatch_group_enter(group);
    dispatch_async(_writerQueue, ^{
        // Rollback any active transaction
        std::string err;
        if (sqlite3_get_autocommit(self->_writerConn.handle()) == 0) {
            self->_writerConn.execute("ROLLBACK", err);
        }

        // Finalize prepared statements owned by the writer
        {
            std::lock_guard<std::mutex> lock(self->_stmtMutex);
            for (auto &pair : self->_preparedStmts) {
                sqlite3_finalize(pair.second.stmt);
            }
            self->_preparedStmts.clear();
        }

        self->_writerConn.close();
        dispatch_group_leave(group);
    });

    // Drain each reader queue: end read transactions, close connections
    std::vector<ReadTxHandle> activeReadTxs;
    {
        std::lock_guard<std::mutex> lock(_readTxMutex);
        for (auto &pair : _readTxHandles) {
            activeReadTxs.push_back(pair.second);
        }
        _readTxHandles.clear();
    }

    for (size_t i = 0; i < _readerConns.size(); i++) {
        dispatch_group_enter(group);
        dispatch_async(_readerQueues[i], ^{
            // End any active read transaction on this reader
            for (auto &rtx : activeReadTxs) {
                if (rtx.readerIndex == (int)i) {
                    std::string err;
                    rtx.conn->execute("END", err);
                }
            }
            self->_readerConns[i]->close();
            delete self->_readerConns[i];
            dispatch_group_leave(group);
        });
    }

    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
        self->_readerConns.clear();
        self->_readerQueues.clear();

        if (completion) {
            completion();
        }
    });
}

- (void)close {
    [self closeWithCompletion:nil];
}

- (void)dealloc {
    // GCD traps on releasing a suspended queue.
    if (_writerQueueSuspended) {
        _writerQueueSuspended = false;
        dispatch_resume(_writerQueue);
    }
    if (_isOpen) {
        _isOpen = NO;
        // Best-effort synchronous cleanup in dealloc
        {
            std::lock_guard<std::mutex> lock(_stmtMutex);
            for (auto &pair : _preparedStmts) {
                sqlite3_finalize(pair.second.stmt);
            }
            _preparedStmts.clear();
        }
        _writerConn.close();
        for (size_t i = 0; i < _readerConns.size(); i++) {
            _readerConns[i]->close();
            delete _readerConns[i];
        }
        _readerConns.clear();
    }
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
