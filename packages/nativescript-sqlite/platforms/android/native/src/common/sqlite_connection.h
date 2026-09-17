#pragma once

// ---------------------------------------------------------------------------
// SQLiteConnection — Layer 3: Pure SQLite execution.
// NO V8, NO JNI, NO Android-specific code except sqlite3.h.
// A pooled connection is used by one worker thread. A serialized connection
// (opts.noMutex == false) is used by a worker thread and the JS thread at once.
// ---------------------------------------------------------------------------

#include "sqlite_types.h"
#include "handle_registry.h"
#include <sqlite3.h>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace NSCSQLite {

// ── Prepared statement wrapper ───────────────────────────────────────────────

struct PreparedStmt {
    sqlite3_stmt* stmt{nullptr};
    std::string   sql{};
    // sqlite3_stmt is not thread-safe; concurrent stepStatement calls on the
    // same handle must be serialized.
    std::mutex    mtx{};

    PreparedStmt() = default;
    explicit PreparedStmt(sqlite3_stmt* s, std::string q)
        : stmt(s), sql(std::move(q)) {}

    ~PreparedStmt() {
        if (stmt) sqlite3_finalize(stmt);
    }

    PreparedStmt(const PreparedStmt&)            = delete;
    PreparedStmt& operator=(const PreparedStmt&) = delete;
};

// ── Transaction state ────────────────────────────────────────────────────────

enum class TxBehavior : uint8_t { Deferred, Immediate, Exclusive };

struct ActiveTransaction {
    uint32_t   id{0};
    int        savepointDepth{0};
};

// ── Connection ───────────────────────────────────────────────────────────────

class SQLiteConnection {
public:
    // Opens the database. On error, isOpen() returns false and lastError() has details.
    explicit SQLiteConnection(const OpenOptions& opts);
    ~SQLiteConnection();

    SQLiteConnection(const SQLiteConnection&)            = delete;
    SQLiteConnection& operator=(const SQLiteConnection&) = delete;

    bool        isOpen()     const { return db_ != nullptr; }
    std::string lastError()  const;
    int         lastCode()   const;

    // Message and code of the last failure, read as one unit.
    QueryResult errorResult() const;

    // ── Execute ─────────────────────────────────────────────────────────────
    // Runs SQL, binds params, returns full QueryResult (rows + metadata).
    QueryResult execute(const std::string& sql, const ParamList& params = {});

    // Same as execute but only returns the first row.
    QueryResult executeGet(const std::string& sql, const ParamList& params = {});

    // ── JSON fast-path (async API) ───────────────────────────────────────────
    // These build result.jsonRows + result.jsonBlobs on the worker thread so
    // the JS thread only needs one v8::JSON::Parse() call instead of
    // O(rowsXcolumns) individual V8 Set() calls.
    QueryResult executeJson(const std::string& sql, const ParamList& params = {});
    QueryResult executeGetJson(const std::string& sql, const ParamList& params = {});
    QueryResult executeArrayJson(const std::string& sql, const ParamList& params = {});
    QueryResult executeGetArrayJson(const std::string& sql, const ParamList& params = {});

    QueryResult selectInTransactionJson(uint32_t txId, const std::string& sql, const ParamList& params = {});
    QueryResult selectInTransactionArrayJson(uint32_t txId, const std::string& sql, const ParamList& params = {});

    // mode false=all rows, true=first row only
    QueryResult stepStatementJson(uint32_t stmtId, const ParamList& params = {}, bool firstOnly = false);
    QueryResult stepStatementArrayJson(uint32_t stmtId, const ParamList& params = {}, bool firstOnly = false);

    // ── Prepared statements ──────────────────────────────────────────────────
    uint32_t    prepareStatement(const std::string& sql);
    QueryResult stepStatement(uint32_t stmtId, const ParamList& params = {});
    void        finalizeStatement(uint32_t stmtId);
    bool        hasStatement(uint32_t stmtId) const;

    // ── Transactions ─────────────────────────────────────────────────────────
    uint32_t beginTransaction(TxBehavior behavior = TxBehavior::Deferred);
    QueryResult executeInTransaction(uint32_t txId, const std::string& sql, const ParamList& params = {});
    QueryResult selectInTransaction(uint32_t txId, const std::string& sql, const ParamList& params = {});
    void        commitTransaction(uint32_t txId);
    void        rollbackTransaction(uint32_t txId);
    bool        hasTransaction(uint32_t txId) const;

    // ── Savepoints ───────────────────────────────────────────────────────────
    void        savepoint(uint32_t txId, const std::string& name);
    void        releaseSavepoint(uint32_t txId, const std::string& name);
    void        rollbackToSavepoint(uint32_t txId, const std::string& name);

    // ── Diagnostics ──────────────────────────────────────────────────────────
    RuntimeInfo getRuntimeInfo() const;

    // ── Lifecycle ────────────────────────────────────────────────────────────
    void close();

private:
    enum class QueryFormat { ObjectRows, ArrayRows };

    using DbGuard = std::lock_guard<std::recursive_mutex>;

    // Helpers
    QueryResult runStatement(sqlite3_stmt* stmt);
    QueryResult runStatementAsJson(sqlite3_stmt* stmt, QueryFormat format, bool firstOnly = false);
    bool        prepareOne(const std::string& sql, sqlite3_stmt** out, bool* isMulti = nullptr);
    void        bindParams(sqlite3_stmt* stmt, const ParamList& params);
    void        setError(const std::string& msg, int code);

    // Runs one open-time statement; on failure records the error, closes the
    // handle and returns false, leaving the connection not-open.
    bool        runOpenStatement(const std::string& sql);

    sqlite3*    db_{nullptr};
    std::string path_{};

    // Held end to end by every public operation. SQLITE_OPEN_FULLMUTEX only makes
    // each individual SQLite call safe, which is not enough for a serialized
    // connection: between a failing call and the sqlite3_errmsg() that explains
    // it, the other thread can clear or free that text, and it can swap
    // sqlite3_changes()/last_insert_rowid() out from under a finished statement.
    // Recursive because the operations delegate to each other.
    mutable std::recursive_mutex opMutex_;

    // A serialized connection is reached from both the dispatcher thread and the
    // JS thread, so the last-error pair needs its own lock.
    mutable std::mutex errorMutex_;
    std::string lastError_{};
    int         lastCode_{SQLITE_OK};

    // Prepared-statement cache — only active for noMutex (single-threaded) connections.
    // Workers must NOT use this path; concurrent bind/step on the same stmt is unsafe.
    bool cacheEnabled_{false};
    std::unordered_map<std::string, sqlite3_stmt*> execCache_;

    HandleRegistry<PreparedStmt>     stmtRegistry_;
    HandleRegistry<ActiveTransaction> txRegistry_;
};

} // namespace NSCSQLite
