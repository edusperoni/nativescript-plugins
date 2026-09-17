#pragma once

// ---------------------------------------------------------------------------
// SQLiteConnection — Layer 3: Pure SQLite execution.
// NO V8, NO JNI, NO Android-specific code except sqlite3.h.
//
// A connection is used by one thread at a time: its dispatcher's worker, plus —
// for the writer — the JS thread, which takes the same claim on that dispatcher
// before it runs anything here. The hand-off between the two is ordered by the
// dispatcher's mutex, which is what lets every connection open NOMUTEX and keep
// its statement cache.
// ---------------------------------------------------------------------------

#include "sqlite_types.h"
#include "handle_registry.h"
#include <sqlite3.h>
#include <atomic>
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
    // A span driven synchronously from the JS thread. It is not counted by
    // hasActiveAsyncTransaction(), so the statements running inside it are not
    // turned away by the safeguard that guards it.
    bool       syncSpan{false};
};

// ── Connection ───────────────────────────────────────────────────────────────

class SQLiteConnection {
public:
    // Constructs a connection that is not open yet. open() may then run on a
    // different thread than this one — deriving an encryption key takes ~90 ms,
    // which must not happen on the JS thread.
    SQLiteConnection() = default;

    // Opens the database. On error, isOpen() returns false and lastError() has details.
    explicit SQLiteConnection(const OpenOptions& opts) { open(opts); }
    ~SQLiteConnection();

    SQLiteConnection(const SQLiteConnection&)            = delete;
    SQLiteConnection& operator=(const SQLiteConnection&) = delete;

    // Runs the whole open sequence on the calling thread. False on failure,
    // which unavailableError() then reports for the life of the connection.
    bool        open(const OpenOptions& opts);

    bool        isOpen()     const { return db_ != nullptr; }
    std::string lastError()  const;
    int         lastCode()   const;

    // Message and code of the last failure, read as one unit.
    QueryResult errorResult() const;

    // Why a connection that is not open cannot run statements: the failure its
    // open recorded, or a closed-database error when it opened and was closed
    // since. Only meaningful while isOpen() is false.
    QueryResult unavailableError() const;

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
    uint32_t beginTransaction(TxBehavior behavior = TxBehavior::Deferred, bool syncSpan = false);
    QueryResult executeInTransaction(uint32_t txId, const std::string& sql, const ParamList& params = {});
    QueryResult selectInTransaction(uint32_t txId, const std::string& sql, const ParamList& params = {});
    // A COMMIT that fails is followed by a ROLLBACK, so the connection is never
    // left carrying a transaction that later statements would silently join.
    QueryResult commitTransaction(uint32_t txId);
    QueryResult rollbackTransaction(uint32_t txId);
    bool        hasTransaction(uint32_t txId) const;

    // True while a transaction opened through the asynchronous beginTransaction
    // is still open. Callable from any thread, and touches no SQLite state.
    bool        hasActiveAsyncTransaction() const {
        return asyncTxCount_.load(std::memory_order_acquire) > 0;
    }

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

    // The open sequence itself; open() wraps it to capture the failure.
    bool        runOpenSequence(const OpenOptions& opts);

    void        forgetTransaction(uint32_t txId);

    sqlite3*    db_{nullptr};
    std::string path_{};

    // Held end to end by every public operation, so a failing call and the
    // sqlite3_errmsg() that explains it cannot be split, and so
    // sqlite3_changes()/last_insert_rowid() still belong to the statement that
    // just finished. Recursive because the operations delegate to each other.
    mutable std::recursive_mutex opMutex_;

    // The accessors below are reached from the JS thread while a worker runs a
    // statement, so the last-error pair needs its own lock.
    mutable std::mutex errorMutex_;
    std::string lastError_{};
    int         lastCode_{SQLITE_OK};

    // Recorded once, by the open that failed, and never overwritten by the
    // errors of the calls that are turned away afterwards.
    bool        openFailed_{false};
    QueryResult openError_{};

    // Prepared-statement cache. Safe because the connection has one user at a
    // time; a cached sqlite3_stmt could not survive concurrent bind/step.
    bool cacheEnabled_{false};
    std::unordered_map<std::string, sqlite3_stmt*> execCache_;

    HandleRegistry<PreparedStmt>     stmtRegistry_;
    HandleRegistry<ActiveTransaction> txRegistry_;

    // Transactions in txRegistry_ that are not sync spans. Separate from the
    // registry because the JS thread polls it before every executeSync.
    std::atomic<int> asyncTxCount_{0};
};

} // namespace NSCSQLite
