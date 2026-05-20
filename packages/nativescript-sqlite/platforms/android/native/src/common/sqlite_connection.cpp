#include "sqlite_connection.h"
#include "json_builder.h"
#include "log.h"

#include <cstring>
#include <sstream>
#include <stdexcept>

namespace NSCSQLite {

// ── Construction / destruction ───────────────────────────────────────────────

SQLiteConnection::SQLiteConnection(const OpenOptions& opts)
    : path_(opts.path)
{
    // SQLITE_OPEN_URI is always added so callers can use URI filenames (e.g.
    // file:name?mode=memory&cache=shared for shared in-memory databases).
    // It is a no-op for regular file paths.
    int flags = opts.readOnly
        ? (SQLITE_OPEN_READONLY | SQLITE_OPEN_URI)
        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI);
    // NOMUTEX for connections accessed from a single thread only (sync path on JS thread).
    // FULLMUTEX for shared connections where worker threads may call concurrently.
    flags |= opts.noMutex ? SQLITE_OPEN_NOMUTEX : SQLITE_OPEN_FULLMUTEX;
    cacheEnabled_ = opts.noMutex; // stmt cache is safe only for single-threaded connections

    int rc = sqlite3_open_v2(opts.path.c_str(), &db_, flags, nullptr);
    if (rc != SQLITE_OK) {
        const char* msg = db_ ? sqlite3_errmsg(db_) : "out of memory";
        setError(std::string("Failed to open: ") + msg, rc);
        if (db_) { sqlite3_close(db_); db_ = nullptr; }
        return;
    }

    // busy timeout
    if (opts.busyTimeoutMs > 0)
        sqlite3_busy_timeout(db_, opts.busyTimeoutMs);

    // Encryption (SQLCipher / SEE pattern)
    if (!opts.encryptionKey.empty()) {
        std::string pragma = "PRAGMA key = '" + opts.encryptionKey + "'";
        char* errmsg = nullptr;
        rc = sqlite3_exec(db_, pragma.c_str(), nullptr, nullptr, &errmsg);
        if (rc != SQLITE_OK) {
            std::string msg = errmsg ? errmsg : "encryption key failed";
            sqlite3_free(errmsg);
            setError(msg, rc);
            sqlite3_close(db_); db_ = nullptr;
            return;
        }
    }

    // Enable WAL for better read concurrency
    if (!opts.readOnly) {
        char* errmsg = nullptr;
        sqlite3_exec(db_, "PRAGMA journal_mode=WAL", nullptr, nullptr, &errmsg);
        sqlite3_free(errmsg);
    }
}

SQLiteConnection::~SQLiteConnection() {
    close();
}

void SQLiteConnection::close() {
    if (!db_) return;
    for (auto& kv : execCache_) {
        sqlite3_finalize(kv.second);
    }
    execCache_.clear();
    stmtRegistry_.clear();
    txRegistry_.clear();
    sqlite3_close_v2(db_);
    db_ = nullptr;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

void SQLiteConnection::setError(const std::string& msg, int code) {
    lastError_ = msg;
    lastCode_  = code;
    LogError("[SQLiteConnection] " + msg + " (code=" + std::to_string(code) + ")");
}

QueryResult SQLiteConnection::errorResult() const {
    QueryResult r;
    r.success   = false;
    r.error     = lastError_;
    r.errorCode = lastCode_;
    return r;
}

void SQLiteConnection::bindParams(sqlite3_stmt* stmt, const ParamList& params) {
    sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);

    for (int i = 0; i < static_cast<int>(params.size()); ++i) {
        const auto& p = params[i];

        int idx;
        if (!p.paramName.empty()) {
            // Named parameter - look up by name; SQLite requires the prefix.
            idx = sqlite3_bind_parameter_index(stmt, p.paramName.c_str());
            if (idx == 0) continue; // parameter not found in this statement - skip
        } else {
            idx = i + 1; // positional - 1-indexed
        }

        switch (p.type) {
            case ColumnType::Integer:
                sqlite3_bind_int64(stmt, idx, p.intValue);
                break;
            case ColumnType::Float:
                sqlite3_bind_double(stmt, idx, p.doubleValue);
                break;
            case ColumnType::Text:
                sqlite3_bind_text(stmt, idx, p.textValue.c_str(),
                                  static_cast<int>(p.textValue.size()),
                                  SQLITE_TRANSIENT);
                break;
            case ColumnType::Blob:
                if (p.blobValue.empty()) {
                    // sqlite3_bind_blob with a null/zero-length ptr is treated as NULL.
                    // Use sqlite3_bind_zeroblob to store a genuine zero-length blob.
                    sqlite3_bind_zeroblob(stmt, idx, 0);
                } else {
                    sqlite3_bind_blob(stmt, idx,
                                      p.blobValue.data(),
                                      static_cast<int>(p.blobValue.size()),
                                      SQLITE_TRANSIENT);
                }
                break;
            case ColumnType::Null:
            default:
                sqlite3_bind_null(stmt, idx);
                break;
        }
    }
}

QueryResult SQLiteConnection::runStatement(sqlite3_stmt* stmt) {
    QueryResult result;
    result.success = true;

    int colCount = sqlite3_column_count(stmt);

    // Capture column names
    result.columnNames.reserve(colCount);
    for (int i = 0; i < colCount; ++i) {
        const char* name = sqlite3_column_name(stmt, i);
        result.columnNames.push_back(name ? name : "");
    }

    int rc;
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        RowData row;
        row.columns.reserve(colCount);

        for (int i = 0; i < colCount; ++i) {
            ColumnValue cv;
            int type = sqlite3_column_type(stmt, i);

            switch (type) {
                case SQLITE_INTEGER:
                    cv.type     = ColumnType::Integer;
                    cv.intValue = sqlite3_column_int64(stmt, i);
                    break;
                case SQLITE_FLOAT:
                    cv.type        = ColumnType::Float;
                    cv.doubleValue = sqlite3_column_double(stmt, i);
                    break;
                case SQLITE_TEXT: {
                    cv.type = ColumnType::Text;
                    const unsigned char* txt = sqlite3_column_text(stmt, i);
                    cv.textValue = txt ? reinterpret_cast<const char*>(txt) : "";
                    break;
                }
                case SQLITE_BLOB: {
                    cv.type = ColumnType::Blob;
                    int bytes = sqlite3_column_bytes(stmt, i);
                    const void* data = sqlite3_column_blob(stmt, i);
                    if (data && bytes > 0) {
                        const uint8_t* begin = static_cast<const uint8_t*>(data);
                        cv.blobValue.assign(begin, begin + bytes);
                    }
                    break;
                }
                case SQLITE_NULL:
                default:
                    cv.type = ColumnType::Null;
                    break;
            }
            row.columns.push_back(std::move(cv));
        }
        result.rows.push_back(std::move(row));
    }

    if (rc != SQLITE_DONE) {
        result.success   = false;
        result.errorCode = rc;
        result.error     = sqlite3_errmsg(db_);
        return result;
    }

    result.insertId     = sqlite3_last_insert_rowid(db_);
    result.rowsAffected = sqlite3_changes(db_);
    return result;
}

// ── Execute ───────────────────────────────────────────────────────────────────

QueryResult SQLiteConnection::execute(const std::string& sql, const ParamList& params) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return errorResult(); }

    sqlite3_stmt* stmt = nullptr;
    bool fromCache = false;

    if (cacheEnabled_) {
        auto it = execCache_.find(sql);
        if (it != execCache_.end()) {
            stmt = it->second;
            fromCache = true;
        }
    }

    if (!stmt) {
        int rc = sqlite3_prepare_v2(db_, sql.c_str(), static_cast<int>(sql.size()), &stmt, nullptr);
        if (rc != SQLITE_OK) {
            setError(sqlite3_errmsg(db_), rc);
            return errorResult();
        }
        if (cacheEnabled_) {
            execCache_[sql] = stmt;
            fromCache = true;
        }
    }

    bindParams(stmt, params);
    QueryResult result = runStatement(stmt);
    if (!fromCache) {
        sqlite3_finalize(stmt);
    }
    // Cached stmts stay alive; bindParams() calls sqlite3_reset() at the start of the next use.

    if (!result.success) setError(result.error, result.errorCode);
    return result;
}

QueryResult SQLiteConnection::executeGet(const std::string& sql, const ParamList& params) {
    QueryResult result = execute(sql, params);
    if (result.success && result.rows.size() > 1) {
        result.rows.resize(1); // keep only first row
    }
    return result;
}

// ── Prepared statements ───────────────────────────────────────────────────────

uint32_t SQLiteConnection::prepareStatement(const std::string& sql) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return 0; }

    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), static_cast<int>(sql.size()), &stmt, nullptr);
    if (rc != SQLITE_OK) {
        setError(sqlite3_errmsg(db_), rc);
        return 0;
    }

    auto ps  = std::make_unique<PreparedStmt>(stmt, sql);
    uint32_t id = stmtRegistry_.add(std::move(ps));
    return id;
}

QueryResult SQLiteConnection::stepStatement(uint32_t stmtId, const ParamList& params) {
    PreparedStmt* ps = stmtRegistry_.get(stmtId);
    if (!ps) {
        setError("invalid statement handle " + std::to_string(stmtId), SQLITE_MISUSE);
        return errorResult();
    }

    // Serialize concurrent calls on the same statement handle.
    std::lock_guard<std::mutex> lock(ps->mtx);
    bindParams(ps->stmt, params);
    QueryResult result = runStatement(ps->stmt);
    if (!result.success) setError(result.error, result.errorCode);
    return result;
}

void SQLiteConnection::finalizeStatement(uint32_t stmtId) {
    stmtRegistry_.remove(stmtId); // destructor calls sqlite3_finalize
}

bool SQLiteConnection::hasStatement(uint32_t stmtId) const {
    return stmtRegistry_.contains(stmtId);
}

// ── Transactions ──────────────────────────────────────────────────────────────

uint32_t SQLiteConnection::beginTransaction(TxBehavior behavior) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return 0; }

    const char* beginSql = "BEGIN";
    switch (behavior) {
        case TxBehavior::Immediate:  beginSql = "BEGIN IMMEDIATE"; break;
        case TxBehavior::Exclusive:  beginSql = "BEGIN EXCLUSIVE"; break;
        default: break;
    }

    char* errmsg = nullptr;
    int rc = sqlite3_exec(db_, beginSql, nullptr, nullptr, &errmsg);
    if (rc != SQLITE_OK) {
        std::string msg = errmsg ? errmsg : "begin transaction failed";
        sqlite3_free(errmsg);
        setError(msg, rc);
        return 0;
    }

    auto tx = std::make_unique<ActiveTransaction>();
    uint32_t id = txRegistry_.add(std::move(tx));
    txRegistry_.get(id)->id = id;
    return id;
}

QueryResult SQLiteConnection::executeInTransaction(uint32_t txId, const std::string& sql, const ParamList& params) {
    if (!txRegistry_.contains(txId)) {
        setError("invalid transaction id " + std::to_string(txId), SQLITE_MISUSE);
        return errorResult();
    }
    return execute(sql, params);
}

QueryResult SQLiteConnection::selectInTransaction(uint32_t txId, const std::string& sql, const ParamList& params) {
    return executeInTransaction(txId, sql, params);
}

void SQLiteConnection::commitTransaction(uint32_t txId) {
    if (!txRegistry_.contains(txId)) { setError("invalid tx id", SQLITE_MISUSE); return; }
    char* errmsg = nullptr;
    sqlite3_exec(db_, "COMMIT", nullptr, nullptr, &errmsg);
    sqlite3_free(errmsg);
    txRegistry_.remove(txId);
}

void SQLiteConnection::rollbackTransaction(uint32_t txId) {
    if (!txRegistry_.contains(txId)) { setError("invalid tx id", SQLITE_MISUSE); return; }
    char* errmsg = nullptr;
    sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, &errmsg);
    sqlite3_free(errmsg);
    txRegistry_.remove(txId);
}

bool SQLiteConnection::hasTransaction(uint32_t txId) const {
    return txRegistry_.contains(txId);
}

// ── Savepoints ────────────────────────────────────────────────────────────────

void SQLiteConnection::savepoint(uint32_t txId, const std::string& name) {
    if (!txRegistry_.contains(txId)) return;
    std::string sql = "SAVEPOINT " + name;
    char* errmsg = nullptr;
    sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &errmsg);
    sqlite3_free(errmsg);
}

void SQLiteConnection::releaseSavepoint(uint32_t txId, const std::string& name) {
    if (!txRegistry_.contains(txId)) return;
    std::string sql = "RELEASE SAVEPOINT " + name;
    char* errmsg = nullptr;
    sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &errmsg);
    sqlite3_free(errmsg);
}

void SQLiteConnection::rollbackToSavepoint(uint32_t txId, const std::string& name) {
    if (!txRegistry_.contains(txId)) return;
    std::string sql = "ROLLBACK TO SAVEPOINT " + name;
    char* errmsg = nullptr;
    sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &errmsg);
    sqlite3_free(errmsg);
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

RuntimeInfo SQLiteConnection::getRuntimeInfo() const {
    RuntimeInfo info;
    info.version  = sqlite3_libversion();
    info.sourceId = sqlite3_sourceid();

    // Enumerate known compile options
    for (int i = 0; ; ++i) {
        const char* opt = sqlite3_compileoption_get(i);
        if (!opt) break;
        info.compileOptions.push_back(opt);
    }
    return info;
}

// ── JSON fast-path helpers ────────────────────────────────────────────────────

static void appendColumnValueToJson(sqlite3_stmt* stmt, int col,
                                    JSONBuilder& jb,
                                    std::vector<std::vector<uint8_t>>& blobs)
{
    switch (sqlite3_column_type(stmt, col)) {
        case SQLITE_INTEGER:
            jb.appendInt(sqlite3_column_int64(stmt, col));
            break;
        case SQLITE_FLOAT:
            jb.appendDouble(sqlite3_column_double(stmt, col));
            break;
        case SQLITE_TEXT: {
            const char* text = reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
            int bytes = sqlite3_column_bytes(stmt, col);
            jb.appendString(text ? text : "", bytes);
            break;
        }
        case SQLITE_BLOB: {
            const void* data  = sqlite3_column_blob(stmt, col);
            int         bytes = sqlite3_column_bytes(stmt, col);
            int blobIdx = static_cast<int>(blobs.size());
            if (data && bytes > 0) {
                const uint8_t* begin = static_cast<const uint8_t*>(data);
                blobs.emplace_back(begin, begin + bytes);
            } else {
                blobs.emplace_back(); // zero-length blob
            }
            jb.appendBlobPlaceholder(blobIdx);
            break;
        }
        default: // SQLITE_NULL
            jb.appendNull();
            break;
    }
}

QueryResult SQLiteConnection::runStatementAsJson(sqlite3_stmt* stmt,
                                                  QueryFormat    format,
                                                  bool           firstOnly)
{
    QueryResult result;
    result.success = true;

    int colCount = sqlite3_column_count(stmt);
    if (colCount == 0) {
        // DML — no rows; this path shouldn't be called for DML but handle it
        result.jsonRows = format == QueryFormat::ObjectRows ? "[]"
                                                            : "{\"columns\":[],\"rows\":[]}";
        result.insertId     = sqlite3_last_insert_rowid(db_);
        result.rowsAffected = sqlite3_changes(db_);
        return result;
    }

    JSONBuilder jb;

    if (format == QueryFormat::ObjectRows) {
        // Collect column names once (sqlite3_column_name is stable per stmt)
        std::vector<std::string> colNames;
        colNames.reserve(colCount);
        for (int i = 0; i < colCount; ++i) {
            const char* n = sqlite3_column_name(stmt, i);
            colNames.emplace_back(n ? n : "");
        }

        jb.raw('[');
        bool first = true;
        int  rc;
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
            if (!first) jb.raw(',');
            first = false;
            jb.raw('{');
            for (int i = 0; i < colCount; ++i) {
                if (i > 0) jb.raw(',');
                jb.appendString(colNames[i]);
                jb.raw(':');
                appendColumnValueToJson(stmt, i, jb, result.jsonBlobs);
            }
            jb.raw('}');
            if (firstOnly) break; // finalize() will clean up the rest
        }
        jb.raw(']');

        if (!firstOnly && rc != SQLITE_DONE) {
            result.success   = false;
            result.errorCode = rc;
            result.error     = sqlite3_errmsg(db_);
            return result;
        }
    } else {
        // ArrayRows: {"columns":[...], "rows":[[...], ...]}
        jb.raw("{\"columns\":[", 12);
        for (int i = 0; i < colCount; ++i) {
            if (i > 0) jb.raw(',');
            const char* n = sqlite3_column_name(stmt, i);
            jb.appendString(n ? n : "", static_cast<int>(n ? strlen(n) : 0));
        }
        jb.raw("],\"rows\":[", 10);

        bool first = true;
        int  rc;
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
            if (!first) jb.raw(',');
            first = false;
            jb.raw('[');
            for (int i = 0; i < colCount; ++i) {
                if (i > 0) jb.raw(',');
                appendColumnValueToJson(stmt, i, jb, result.jsonBlobs);
            }
            jb.raw(']');
            if (firstOnly) break;
        }
        jb.raw("]}", 2);

        if (!firstOnly && rc != SQLITE_DONE) {
            result.success   = false;
            result.errorCode = rc;
            result.error     = sqlite3_errmsg(db_);
            return result;
        }
    }

    result.jsonRows     = jb.take();
    result.insertId     = sqlite3_last_insert_rowid(db_);
    result.rowsAffected = sqlite3_changes(db_);
    return result;
}

// ── JSON public methods ───────────────────────────────────────────────────────

QueryResult SQLiteConnection::executeJson(const std::string& sql, const ParamList& params) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return errorResult(); }
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), static_cast<int>(sql.size()), &stmt, nullptr);
    if (rc != SQLITE_OK) { setError(sqlite3_errmsg(db_), rc); return errorResult(); }
    bindParams(stmt, params);
    QueryResult r = runStatementAsJson(stmt, QueryFormat::ObjectRows, false);
    sqlite3_finalize(stmt);
    if (!r.success) setError(r.error, r.errorCode);
    return r;
}

QueryResult SQLiteConnection::executeGetJson(const std::string& sql, const ParamList& params) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return errorResult(); }
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), static_cast<int>(sql.size()), &stmt, nullptr);
    if (rc != SQLITE_OK) { setError(sqlite3_errmsg(db_), rc); return errorResult(); }
    bindParams(stmt, params);
    QueryResult r = runStatementAsJson(stmt, QueryFormat::ObjectRows, true);
    sqlite3_finalize(stmt);
    if (!r.success) setError(r.error, r.errorCode);
    return r;
}

QueryResult SQLiteConnection::executeArrayJson(const std::string& sql, const ParamList& params) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return errorResult(); }
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), static_cast<int>(sql.size()), &stmt, nullptr);
    if (rc != SQLITE_OK) { setError(sqlite3_errmsg(db_), rc); return errorResult(); }
    bindParams(stmt, params);
    QueryResult r = runStatementAsJson(stmt, QueryFormat::ArrayRows, false);
    sqlite3_finalize(stmt);
    if (!r.success) setError(r.error, r.errorCode);
    return r;
}

QueryResult SQLiteConnection::executeGetArrayJson(const std::string& sql, const ParamList& params) {
    if (!db_) { setError("database is closed", SQLITE_MISUSE); return errorResult(); }
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, sql.c_str(), static_cast<int>(sql.size()), &stmt, nullptr);
    if (rc != SQLITE_OK) { setError(sqlite3_errmsg(db_), rc); return errorResult(); }
    bindParams(stmt, params);
    QueryResult r = runStatementAsJson(stmt, QueryFormat::ArrayRows, true);
    sqlite3_finalize(stmt);
    if (!r.success) setError(r.error, r.errorCode);
    return r;
}

QueryResult SQLiteConnection::selectInTransactionJson(uint32_t txId,
                                                       const std::string& sql,
                                                       const ParamList& params) {
    if (!txRegistry_.contains(txId)) {
        setError("invalid transaction id " + std::to_string(txId), SQLITE_MISUSE);
        return errorResult();
    }
    return executeJson(sql, params);
}

QueryResult SQLiteConnection::selectInTransactionArrayJson(uint32_t txId,
                                                            const std::string& sql,
                                                            const ParamList& params) {
    if (!txRegistry_.contains(txId)) {
        setError("invalid transaction id " + std::to_string(txId), SQLITE_MISUSE);
        return errorResult();
    }
    return executeArrayJson(sql, params);
}

QueryResult SQLiteConnection::stepStatementJson(uint32_t stmtId,
                                                 const ParamList& params,
                                                 bool firstOnly) {
    PreparedStmt* ps = stmtRegistry_.get(stmtId);
    if (!ps) { setError("invalid statement handle " + std::to_string(stmtId), SQLITE_MISUSE); return errorResult(); }
    std::lock_guard<std::mutex> lock(ps->mtx);
    bindParams(ps->stmt, params);
    QueryResult r = runStatementAsJson(ps->stmt, QueryFormat::ObjectRows, firstOnly);
    if (!r.success) setError(r.error, r.errorCode);
    return r;
}

QueryResult SQLiteConnection::stepStatementArrayJson(uint32_t stmtId,
                                                      const ParamList& params,
                                                      bool firstOnly) {
    PreparedStmt* ps = stmtRegistry_.get(stmtId);
    if (!ps) { setError("invalid statement handle " + std::to_string(stmtId), SQLITE_MISUSE); return errorResult(); }
    std::lock_guard<std::mutex> lock(ps->mtx);
    bindParams(ps->stmt, params);
    QueryResult r = runStatementAsJson(ps->stmt, QueryFormat::ArrayRows, firstOnly);
    if (!r.success) setError(r.error, r.errorCode);
    return r;
}

} // namespace NSCSQLite
