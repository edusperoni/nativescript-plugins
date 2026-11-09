#pragma once

// ---------------------------------------------------------------------------
// NapiRuntimeAdapter — Layer 1: converts native result structs to JS values
// and settles promises.
//
// promiseCtx is a napi_deferred; returnCtx is a NapiReturn.
// Every method runs on the thread that owns the env.
// ---------------------------------------------------------------------------

#include "../../common/sqlite_types.h"
#include <node_api.h>
#include <cstdint>
#include <string>

namespace NSCSQLite {

// Sync call sites hand this in as returnCtx and read `value` back out.
struct NapiReturn {
    napi_env   env{nullptr};
    napi_value value{nullptr};
};

class NapiRuntimeAdapter {
public:
    NapiRuntimeAdapter() = default;
    ~NapiRuntimeAdapter() = default;

    NapiRuntimeAdapter(const NapiRuntimeAdapter&)            = delete;
    NapiRuntimeAdapter& operator=(const NapiRuntimeAdapter&) = delete;

    // Caches JSON.parse for the async fast path.
    bool init(napi_env env);

    napi_env env() const { return env_; }

    void resolveWithRows(void* promiseCtx, const QueryResult& result);
    void resolveWithFirstRow(void* promiseCtx, const QueryResult& result);
    void resolveWithArrayResult(void* promiseCtx, const QueryResult& result);
    void resolveWithFirstArrayRow(void* promiseCtx, const QueryResult& result);
    void resolveVoid(void* promiseCtx);
    void resolveWithId(void* promiseCtx, uint32_t id);
    void resolveWithRuntimeInfo(void* promiseCtx, const RuntimeInfo& info);
    void reject(void* promiseCtx, const std::string& message, int code);

    void returnRows(void* returnCtx, const QueryResult& result);
    void returnFirstRow(void* returnCtx, const QueryResult& result);
    void returnArrayResult(void* returnCtx, const QueryResult& result);
    void returnFirstArrayRow(void* returnCtx, const QueryResult& result);
    void returnVoid(void* returnCtx);

    // Structured path, shared by the sync methods and the non-JSON fallback.
    napi_value columnToValue(const ColumnValue& column);
    napi_value rowsToArray(const QueryResult& result);
    napi_value firstRowOrUndefined(const QueryResult& result);
    napi_value arrayResultToObject(const QueryResult& result, bool firstRowOnly);
    napi_value runtimeInfoToObject(const RuntimeInfo& info);

private:
    // Returns nullptr and leaves no pending exception on a parse failure.
    napi_value parseJson(const std::string& json);
    void rejectParseFailure(napi_deferred deferred);

    napi_env env_{nullptr};
    napi_ref json_{nullptr};      // the JSON object, used as the parse receiver
    napi_ref jsonParse_{nullptr}; // JSON.parse
};

} // namespace NSCSQLite
