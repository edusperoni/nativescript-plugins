#pragma once

// ---------------------------------------------------------------------------
// NapiRuntimeAdapter — Layer 1: Node-API implementation of RuntimeAdapter.
//
// promiseCtx is a napi_deferred; returnCtx is a NapiReturn.
// Every method runs on the thread that owns the env.
// ---------------------------------------------------------------------------

#include "../runtime_adapter.h"
#include <node_api.h>

namespace NSCSQLite {

// Sync call sites hand this in as returnCtx and read `value` back out.
struct NapiReturn {
    napi_env   env{nullptr};
    napi_value value{nullptr};
};

class NapiRuntimeAdapter : public RuntimeAdapter {
public:
    NapiRuntimeAdapter() = default;
    ~NapiRuntimeAdapter() override = default;

    NapiRuntimeAdapter(const NapiRuntimeAdapter&)            = delete;
    NapiRuntimeAdapter& operator=(const NapiRuntimeAdapter&) = delete;

    // Caches JSON.parse for the async fast path.
    bool init(napi_env env);

    napi_env env() const { return env_; }

    void resolveWithRows(void* promiseCtx, const QueryResult& result) override;
    void resolveWithFirstRow(void* promiseCtx, const QueryResult& result) override;
    void resolveWithArrayResult(void* promiseCtx, const QueryResult& result) override;
    void resolveWithFirstArrayRow(void* promiseCtx, const QueryResult& result) override;
    void resolveVoid(void* promiseCtx) override;
    void resolveWithId(void* promiseCtx, uint32_t id) override;
    void resolveWithRuntimeInfo(void* promiseCtx, const RuntimeInfo& info) override;
    void reject(void* promiseCtx, const std::string& message, int code) override;

    void returnRows(void* returnCtx, const QueryResult& result) override;
    void returnFirstRow(void* returnCtx, const QueryResult& result) override;
    void returnArrayResult(void* returnCtx, const QueryResult& result) override;
    void returnFirstArrayRow(void* returnCtx, const QueryResult& result) override;
    void returnVoid(void* returnCtx) override;

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
