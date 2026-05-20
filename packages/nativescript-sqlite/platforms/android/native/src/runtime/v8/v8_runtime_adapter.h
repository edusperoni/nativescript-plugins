#pragma once

#include "../runtime_adapter.h"
#include "v8.h"

namespace NSCSQLite {

// ---------------------------------------------------------------------------
// V8RuntimeAdapter — Layer 1: Concrete V8 implementation of RuntimeAdapter
//
// Converts SQLite result structs to V8 values and resolves/rejects
// V8 Promises. This is the only place (along with bindings) where V8
// interacts with the QueryResult data.
// ---------------------------------------------------------------------------

class V8RuntimeAdapter : public RuntimeAdapter {
public:
    explicit V8RuntimeAdapter(v8::Isolate* isolate);
    ~V8RuntimeAdapter() override = default;

    // Async resolution
    void resolveWithRows(void* promiseCtx, const QueryResult& result) override;
    void resolveWithFirstRow(void* promiseCtx, const QueryResult& result) override;
    void resolveWithArrayResult(void* promiseCtx, const QueryResult& result) override;
    void resolveWithFirstArrayRow(void* promiseCtx, const QueryResult& result) override;
    void resolveVoid(void* promiseCtx) override;
    void resolveWithId(void* promiseCtx, uint32_t id) override;
    void resolveWithRuntimeInfo(void* promiseCtx, const RuntimeInfo& info) override;
    void reject(void* promiseCtx, const std::string& message, int code) override;

    // Sync return
    void returnRows(void* returnCtx, const QueryResult& result) override;
    void returnFirstRow(void* returnCtx, const QueryResult& result) override;
    void returnArrayResult(void* returnCtx, const QueryResult& result) override;
    void returnFirstArrayRow(void* returnCtx, const QueryResult& result) override;
    void returnVoid(void* returnCtx) override;

private:
    v8::Local<v8::Value> columnToV8(v8::Local<v8::Context> ctx, const ColumnValue& cv);
    v8::Local<v8::Object> rowToObject(v8::Local<v8::Context> ctx, const std::vector<std::string>& colNames, const RowData& row);
    v8::Local<v8::Array> rowToArray(v8::Local<v8::Context> ctx, const RowData& row);

    v8::Isolate* isolate_;
    // Saved at construction time (on the V8 thread) so async completions
    // running on worker threads can enter the correct context after acquiring
    // v8::Locker.
    v8::Persistent<v8::Context> context_;
};

} // namespace NSCSQLite
