#include "v8_runtime_adapter.h"
#include "v8_helpers.h"

namespace NSCSQLite {

V8RuntimeAdapter::V8RuntimeAdapter(v8::Isolate* isolate) : isolate_(isolate) {
    context_.Reset(isolate, isolate->GetCurrentContext());
}

// Sync helpers (kept for the sync API / return* methods)

v8::Local<v8::Value> V8RuntimeAdapter::columnToV8(v8::Local<v8::Context> ctx, const ColumnValue& cv) {
    switch (cv.type) {
        case ColumnType::Integer:
            return v8::Number::New(isolate_, static_cast<double>(cv.intValue));
        case ColumnType::Float:
            return v8::Number::New(isolate_, cv.doubleValue);
        case ColumnType::Text:
            return V8Helpers::ToV8String(isolate_, cv.textValue);
        case ColumnType::Blob:
            return V8Helpers::ToV8ArrayBuffer(isolate_, cv.blobValue.data(), cv.blobValue.size());
        case ColumnType::Null:
        default:
            return v8::Null(isolate_);
    }
}

v8::Local<v8::Object> V8RuntimeAdapter::rowToObject(v8::Local<v8::Context> ctx,
                                                      const std::vector<std::string>& colNames,
                                                      const RowData& row) {
    auto obj = v8::Object::New(isolate_);
    for (size_t i = 0; i < row.columns.size() && i < colNames.size(); ++i) {
        V8Helpers::SetProp(isolate_, ctx, obj, colNames[i].c_str(), columnToV8(ctx, row.columns[i]));
    }
    return obj;
}

v8::Local<v8::Array> V8RuntimeAdapter::rowToArray(v8::Local<v8::Context> ctx, const RowData& row) {
    auto arr = v8::Array::New(isolate_, static_cast<int>(row.columns.size()));
    for (size_t i = 0; i < row.columns.size(); ++i) {
        arr->Set(ctx, static_cast<uint32_t>(i), columnToV8(ctx, row.columns[i])).Check();
    }
    return arr;
}

// JSON fast-path: blob hydration
// After v8::JSON::Parse replaces all __blob__ placeholder objects with real
// ArrayBuffers.  Only called when result.jsonBlobs is non-empty.

static void hydrateObjectRows(v8::Isolate* isolate,
                               v8::Local<v8::Context> ctx,
                               v8::Local<v8::Array> rows,
                               const std::vector<std::vector<uint8_t>>& blobs)
{
    auto blobKey = v8::String::NewFromUtf8Literal(isolate, "__blob__");
    uint32_t rowCount = rows->Length();
    for (uint32_t r = 0; r < rowCount; ++r) {
        auto rowVal = rows->Get(ctx, r).ToLocalChecked();
        if (!rowVal->IsObject() || rowVal->IsArray()) continue;
        auto rowObj = rowVal.As<v8::Object>();
        auto names = rowObj->GetOwnPropertyNames(ctx).ToLocalChecked();
        for (uint32_t p = 0; p < names->Length(); ++p) {
            auto key = names->Get(ctx, p).ToLocalChecked();
            auto val = rowObj->Get(ctx, key).ToLocalChecked();
            if (!val->IsObject() || val->IsArray() || val->IsNull()) continue;
            auto blobProp = val.As<v8::Object>()->Get(ctx, blobKey).ToLocalChecked();
            if (!blobProp->IsInt32()) continue;
            int idx = blobProp->Int32Value(ctx).ToChecked();
            if (idx >= 0 && static_cast<size_t>(idx) < blobs.size()) {
                const auto& b = blobs[static_cast<size_t>(idx)];
                rowObj->Set(ctx, key, V8Helpers::ToV8ArrayBuffer(isolate, b.data(), b.size())).Check();
            }
        }
    }
}

static void hydrateArrayRows(v8::Isolate* isolate,
                              v8::Local<v8::Context> ctx,
                              v8::Local<v8::Array> rows,
                              const std::vector<std::vector<uint8_t>>& blobs)
{
    auto blobKey = v8::String::NewFromUtf8Literal(isolate, "__blob__");
    uint32_t rowCount = rows->Length();
    for (uint32_t r = 0; r < rowCount; ++r) {
        auto rowVal = rows->Get(ctx, r).ToLocalChecked();
        if (!rowVal->IsArray()) continue;
        auto rowArr = rowVal.As<v8::Array>();
        for (uint32_t c = 0; c < rowArr->Length(); ++c) {
            auto val = rowArr->Get(ctx, c).ToLocalChecked();
            if (!val->IsObject() || val->IsArray() || val->IsNull()) continue;
            auto blobProp = val.As<v8::Object>()->Get(ctx, blobKey).ToLocalChecked();
            if (!blobProp->IsInt32()) continue;
            int idx = blobProp->Int32Value(ctx).ToChecked();
            if (idx >= 0 && static_cast<size_t>(idx) < blobs.size()) {
                const auto& b = blobs[static_cast<size_t>(idx)];
                rowArr->Set(ctx, c, V8Helpers::ToV8ArrayBuffer(isolate, b.data(), b.size())).Check();
            }
        }
    }
}

// Helper: parse jsonRows string into a V8 value, reject on failure.
// Returns an empty Local on failure (caller should return immediately).
static v8::Local<v8::Value> parseJson(v8::Isolate* isolate,
                                       v8::Local<v8::Context> ctx,
                                       v8::Local<v8::Promise::Resolver> resolver,
                                       const std::string& json)
{
    auto jsonStr = V8Helpers::ToV8String(isolate, json);
    auto maybe   = v8::JSON::Parse(ctx, jsonStr);
    if (maybe.IsEmpty()) {
        resolver->Reject(ctx, v8::Exception::Error(
            V8Helpers::ToV8String(isolate, "SQLite JSON result parse error"))).IsJust();
        return {};
    }
    return maybe.ToLocalChecked();
}

// Async resolve methods

void V8RuntimeAdapter::resolveWithRows(void* promiseCtx, const QueryResult& result) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);

    v8::Local<v8::Value> resolved;
    if (!result.jsonRows.empty()) {
        resolved = parseJson(isolate_, ctx, resolver, result.jsonRows);
        if (resolved.IsEmpty()) { pr->Reset(); delete pr; return; }
        if (!result.jsonBlobs.empty() && resolved->IsArray()) {
            hydrateObjectRows(isolate_, ctx, resolved.As<v8::Array>(), result.jsonBlobs);
        }
    } else {
        auto arr = v8::Array::New(isolate_, static_cast<int>(result.rows.size()));
        for (size_t i = 0; i < result.rows.size(); ++i) {
            arr->Set(ctx, static_cast<uint32_t>(i),
                     rowToObject(ctx, result.columnNames, result.rows[i])).Check();
        }
        resolved = arr;
    }

    resolver->Resolve(ctx, resolved).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::resolveWithFirstRow(void* promiseCtx, const QueryResult& result) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);

    v8::Local<v8::Value> resolved;
    if (!result.jsonRows.empty()) {
        // jsonRows is "[{...}]" (0 or 1 elements) â€” take index 0
        auto arr = parseJson(isolate_, ctx, resolver, result.jsonRows);
        if (arr.IsEmpty()) { pr->Reset(); delete pr; return; }
        if (arr->IsArray()) {
            auto arrLocal = arr.As<v8::Array>();
            if (arrLocal->Length() == 0) {
                resolved = v8::Undefined(isolate_);
            } else {
                if (!result.jsonBlobs.empty()) {
                    // Hydrate the single-row array before extracting
                    hydrateObjectRows(isolate_, ctx, arrLocal, result.jsonBlobs);
                }
                resolved = arrLocal->Get(ctx, 0).ToLocalChecked();
            }
        } else {
            resolved = v8::Undefined(isolate_);
        }
    } else {
        resolved = result.rows.empty()
            ? v8::Local<v8::Value>(v8::Undefined(isolate_))
            : v8::Local<v8::Value>(rowToObject(ctx, result.columnNames, result.rows[0]));
    }

    resolver->Resolve(ctx, resolved).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::resolveWithArrayResult(void* promiseCtx, const QueryResult& result) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);

    v8::Local<v8::Value> resolved;
    if (!result.jsonRows.empty()) {
        // jsonRows is {"columns":[...],"rows":[[...],...]}
        resolved = parseJson(isolate_, ctx, resolver, result.jsonRows);
        if (resolved.IsEmpty()) { pr->Reset(); delete pr; return; }
        if (!result.jsonBlobs.empty() && resolved->IsObject()) {
            auto rowsKey = v8::String::NewFromUtf8Literal(isolate_, "rows");
            auto rowsVal = resolved.As<v8::Object>()->Get(ctx, rowsKey).ToLocalChecked();
            if (rowsVal->IsArray()) {
                hydrateArrayRows(isolate_, ctx, rowsVal.As<v8::Array>(), result.jsonBlobs);
            }
        }
    } else {
        auto obj = v8::Object::New(isolate_);
        auto colsArr = v8::Array::New(isolate_, static_cast<int>(result.columnNames.size()));
        for (size_t i = 0; i < result.columnNames.size(); ++i) {
            colsArr->Set(ctx, static_cast<uint32_t>(i),
                         V8Helpers::ToV8String(isolate_, result.columnNames[i])).Check();
        }
        V8Helpers::SetProp(isolate_, ctx, obj, "columns", colsArr);
        auto rowsArr = v8::Array::New(isolate_, static_cast<int>(result.rows.size()));
        for (size_t i = 0; i < result.rows.size(); ++i) {
            rowsArr->Set(ctx, static_cast<uint32_t>(i),
                         rowToArray(ctx, result.rows[i])).Check();
        }
        V8Helpers::SetProp(isolate_, ctx, obj, "rows", rowsArr);
        resolved = obj;
    }

    resolver->Resolve(ctx, resolved).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::resolveWithFirstArrayRow(void* promiseCtx, const QueryResult& result) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);

    v8::Local<v8::Value> resolved;
    if (!result.jsonRows.empty()) {
        // jsonRows is {"columns":[...],"rows":[[...]]} with 0 or 1 rows (firstOnly=true)
        resolved = parseJson(isolate_, ctx, resolver, result.jsonRows);
        if (resolved.IsEmpty()) { pr->Reset(); delete pr; return; }
        if (!result.jsonBlobs.empty() && resolved->IsObject()) {
            auto rowsKey = v8::String::NewFromUtf8Literal(isolate_, "rows");
            auto rowsVal = resolved.As<v8::Object>()->Get(ctx, rowsKey).ToLocalChecked();
            if (rowsVal->IsArray()) {
                hydrateArrayRows(isolate_, ctx, rowsVal.As<v8::Array>(), result.jsonBlobs);
            }
        }
    } else {
        auto obj = v8::Object::New(isolate_);
        auto colsArr = v8::Array::New(isolate_, static_cast<int>(result.columnNames.size()));
        for (size_t i = 0; i < result.columnNames.size(); ++i) {
            colsArr->Set(ctx, static_cast<uint32_t>(i),
                         V8Helpers::ToV8String(isolate_, result.columnNames[i])).Check();
        }
        V8Helpers::SetProp(isolate_, ctx, obj, "columns", colsArr);
        auto rowsArr = v8::Array::New(isolate_);
        if (!result.rows.empty()) {
            rowsArr->Set(ctx, 0, rowToArray(ctx, result.rows[0])).Check();
        }
        V8Helpers::SetProp(isolate_, ctx, obj, "rows", rowsArr);
        resolved = obj;
    }

    resolver->Resolve(ctx, resolved).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::resolveVoid(void* promiseCtx) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);
    resolver->Resolve(ctx, v8::Undefined(isolate_)).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::resolveWithId(void* promiseCtx, uint32_t id) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);
    resolver->Resolve(ctx, v8::Integer::NewFromUnsigned(isolate_, id)).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::resolveWithRuntimeInfo(void* promiseCtx, const RuntimeInfo& info) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = isolate_->GetCurrentContext();
    auto resolver = pr->Get(isolate_);

    auto obj = v8::Object::New(isolate_);
    V8Helpers::SetProp(isolate_, ctx, obj, "version",  V8Helpers::ToV8String(isolate_, info.version));
    V8Helpers::SetProp(isolate_, ctx, obj, "sourceId", V8Helpers::ToV8String(isolate_, info.sourceId));
    auto arr = v8::Array::New(isolate_, static_cast<int>(info.compileOptions.size()));
    for (size_t i = 0; i < info.compileOptions.size(); ++i) {
        arr->Set(ctx, static_cast<uint32_t>(i),
                 V8Helpers::ToV8String(isolate_, info.compileOptions[i])).Check();
    }
    V8Helpers::SetProp(isolate_, ctx, obj, "compileOptions", arr);
    resolver->Resolve(ctx, obj).IsJust();
    pr->Reset(); delete pr;
}

void V8RuntimeAdapter::reject(void* promiseCtx, const std::string& message, int code) {
    auto* pr = static_cast<v8::Persistent<v8::Promise::Resolver>*>(promiseCtx);
    v8::HandleScope scope(isolate_);
    auto ctx      = context_.Get(isolate_);
    v8::Context::Scope ctx_scope(ctx);
    auto resolver = pr->Get(isolate_);
    auto errObj = v8::Exception::Error(V8Helpers::ToV8String(isolate_, message)).As<v8::Object>();
    V8Helpers::SetProp(isolate_, ctx, errObj, "code", v8::Integer::New(isolate_, code));
    resolver->Reject(ctx, errObj).IsJust();
    pr->Reset(); delete pr;
}

// Sync return methods (use structured rows â€” no JSON needed)

void V8RuntimeAdapter::returnRows(void* returnCtx, const QueryResult& result) {
    auto* args = static_cast<v8::FunctionCallbackInfo<v8::Value>*>(returnCtx);
    auto ctx = isolate_->GetCurrentContext();
    auto arr = v8::Array::New(isolate_, static_cast<int>(result.rows.size()));
    for (size_t i = 0; i < result.rows.size(); ++i) {
        arr->Set(ctx, static_cast<uint32_t>(i),
                 rowToObject(ctx, result.columnNames, result.rows[i])).Check();
    }
    args->GetReturnValue().Set(arr);
}

void V8RuntimeAdapter::returnFirstRow(void* returnCtx, const QueryResult& result) {
    auto* args = static_cast<v8::FunctionCallbackInfo<v8::Value>*>(returnCtx);
    auto ctx = isolate_->GetCurrentContext();
    if (result.rows.empty()) {
        args->GetReturnValue().Set(v8::Undefined(isolate_));
    } else {
        args->GetReturnValue().Set(rowToObject(ctx, result.columnNames, result.rows[0]));
    }
}

void V8RuntimeAdapter::returnArrayResult(void* returnCtx, const QueryResult& result) {
    auto* args = static_cast<v8::FunctionCallbackInfo<v8::Value>*>(returnCtx);
    auto ctx = isolate_->GetCurrentContext();
    auto obj = v8::Object::New(isolate_);
    auto colsArr = v8::Array::New(isolate_, static_cast<int>(result.columnNames.size()));
    for (size_t i = 0; i < result.columnNames.size(); ++i) {
        colsArr->Set(ctx, static_cast<uint32_t>(i),
                     V8Helpers::ToV8String(isolate_, result.columnNames[i])).Check();
    }
    V8Helpers::SetProp(isolate_, ctx, obj, "columns", colsArr);
    auto rowsArr = v8::Array::New(isolate_, static_cast<int>(result.rows.size()));
    for (size_t i = 0; i < result.rows.size(); ++i) {
        rowsArr->Set(ctx, static_cast<uint32_t>(i), rowToArray(ctx, result.rows[i])).Check();
    }
    V8Helpers::SetProp(isolate_, ctx, obj, "rows", rowsArr);
    args->GetReturnValue().Set(obj);
}

void V8RuntimeAdapter::returnFirstArrayRow(void* returnCtx, const QueryResult& result) {
    auto* args = static_cast<v8::FunctionCallbackInfo<v8::Value>*>(returnCtx);
    auto ctx = isolate_->GetCurrentContext();
    auto obj = v8::Object::New(isolate_);
    auto colsArr = v8::Array::New(isolate_, static_cast<int>(result.columnNames.size()));
    for (size_t i = 0; i < result.columnNames.size(); ++i) {
        colsArr->Set(ctx, static_cast<uint32_t>(i),
                     V8Helpers::ToV8String(isolate_, result.columnNames[i])).Check();
    }
    V8Helpers::SetProp(isolate_, ctx, obj, "columns", colsArr);
    auto rowsArr = v8::Array::New(isolate_);
    if (!result.rows.empty()) {
        rowsArr->Set(ctx, 0, rowToArray(ctx, result.rows[0])).Check();
    }
    V8Helpers::SetProp(isolate_, ctx, obj, "rows", rowsArr);
    args->GetReturnValue().Set(obj);
}

void V8RuntimeAdapter::returnVoid(void* returnCtx) {
    auto* args = static_cast<v8::FunctionCallbackInfo<v8::Value>*>(returnCtx);
    args->GetReturnValue().SetUndefined();
}

} // namespace NSCSQLite
