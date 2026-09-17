#pragma once

// ---------------------------------------------------------------------------
// RuntimeAdapter — Layer 1: Abstract runtime interface.
//
// Implementations convert native result structs → runtime values and
// resolve/reject promises.  No SQLite types leak into this interface.
//
// Current implementation: V8RuntimeAdapter
// Future implementations: NapiRuntimeAdapter, HermesRuntimeAdapter, etc.
// ---------------------------------------------------------------------------

#include "../common/sqlite_types.h"
#include <cstdint>
#include <string>

namespace NSCSQLite {

class RuntimeAdapter {
public:
    virtual ~RuntimeAdapter() = default;

    // ── Async promise resolution ──────────────────────────────────────────
    // promiseCtx is an opaque handle to a platform promise resolver.
    // All methods run on the runtime thread.

    // Resolve with full QueryResult rows (SELECT queries)
    virtual void resolveWithRows(void* promiseCtx, const QueryResult& result) = 0;

    // Resolve with first row only (GET queries)
    virtual void resolveWithFirstRow(void* promiseCtx, const QueryResult& result) = 0;

    // Resolve with column-array result {columns, rows[][]}
    virtual void resolveWithArrayResult(void* promiseCtx, const QueryResult& result) = 0;

    // Resolve with first row as array (GETARRAY queries)
    virtual void resolveWithFirstArrayRow(void* promiseCtx, const QueryResult& result) = 0;

    // Resolve with undefined / void (execute, close, finalize)
    virtual void resolveVoid(void* promiseCtx) = 0;

    // Resolve with an integer (beginTransaction → txId, prepare → stmtId)
    virtual void resolveWithId(void* promiseCtx, uint32_t id) = 0;

    // Resolve with runtime diagnostics info
    virtual void resolveWithRuntimeInfo(void* promiseCtx, const RuntimeInfo& info) = 0;

    // Reject the promise
    virtual void reject(void* promiseCtx,
                        const std::string& message,
                        int code) = 0;

    // ── Synchronous return helpers ────────────────────────────────────────
    // These write return values into a FunctionCallbackInfo-like slot.
    // returnCtx is platform-specific (for V8: const FunctionCallbackInfo*)

    virtual void returnRows(void* returnCtx, const QueryResult& result)       = 0;
    virtual void returnFirstRow(void* returnCtx, const QueryResult& result)   = 0;
    virtual void returnArrayResult(void* returnCtx, const QueryResult& result) = 0;
    virtual void returnFirstArrayRow(void* returnCtx, const QueryResult& result) = 0;
    virtual void returnVoid(void* returnCtx)                                  = 0;
};

} // namespace NSCSQLite
