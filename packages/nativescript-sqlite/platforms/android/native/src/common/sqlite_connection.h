#pragma once

// ---------------------------------------------------------------------------
// SQLiteConnection — Layer 3: Pure SQLite execution.
// NO V8, NO JNI, NO Android-specific code except sqlite3.h.
// All methods are called from worker threads.
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
    std::string lastError()  const { return lastError_; }
    int         lastCode()   const { return lastCode_; }

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

    // Helpers
    QueryResult runStatement(sqlite3_stmt* stmt);
    QueryResult runStatementAsJson(sqlite3_stmt* stmt, QueryFormat format, bool firstOnly = false);
    void        bindParams(sqlite3_stmt* stmt, const ParamList& params);
    void        setError(const std::string& msg, int code);
    QueryResult errorResult() const;

    sqlite3*    db_{nullptr};
    std::string path_{};
    std::string lastError_{};
    int         lastCode_{SQLITE_OK};

    // Write serialization — SQLite serialized mode or WAL with a write mutex
    mutable std::mutex writeMutex_;

    // Prepared-statement cache — only active for noMutex (single-threaded) connections.
    // Workers must NOT use this path; concurrent bind/step on the same stmt is unsafe.
    bool cacheEnabled_{false};
    std::unordered_map<std::string, sqlite3_stmt*> execCache_;

    HandleRegistry<PreparedStmt>     stmtRegistry_;
    HandleRegistry<ActiveTransaction> txRegistry_;
};

} // namespace NSCSQLite
