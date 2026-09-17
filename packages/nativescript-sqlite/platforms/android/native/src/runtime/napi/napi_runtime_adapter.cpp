#include "napi_runtime_adapter.h"
#include "napi_helpers.h"
#include "../../common/log.h"

namespace NSCSQLite {

using NapiHelpers::ArrayBufferFrom;
using NapiHelpers::String;

// ── Structured path ─────────────────────────────────────────────────────────

// Column names are turned into key values once per result, not once per cell.
static void makeKeys(napi_env env,
                     const std::vector<std::string>& names,
                     std::vector<napi_value>& out)
{
    out.resize(names.size());
    for (size_t i = 0; i < names.size(); ++i) {
        out[i] = String(env, names[i]);
    }
}

napi_value NapiRuntimeAdapter::columnToValue(const ColumnValue& column)
{
    napi_value value = nullptr;
    switch (column.type) {
        case ColumnType::Integer:
            napi_create_double(env_, static_cast<double>(column.intValue), &value);
            return value;
        case ColumnType::Float:
            napi_create_double(env_, column.doubleValue, &value);
            return value;
        case ColumnType::Text:
            return String(env_, column.textValue);
        case ColumnType::Blob:
            return ArrayBufferFrom(env_, column.blobValue.data(), column.blobValue.size());
        case ColumnType::Null:
        default:
            napi_get_null(env_, &value);
            return value;
    }
}

static napi_value rowToObject(NapiRuntimeAdapter& adapter,
                              napi_env env,
                              const std::vector<napi_value>& keys,
                              const RowData& row)
{
    napi_value obj = nullptr;
    if (napi_create_object(env, &obj) != napi_ok) return nullptr;
    for (size_t i = 0; i < row.columns.size() && i < keys.size(); ++i) {
        napi_set_property(env, obj, keys[i], adapter.columnToValue(row.columns[i]));
    }
    return obj;
}

static napi_value rowToArray(NapiRuntimeAdapter& adapter, napi_env env, const RowData& row)
{
    napi_value arr = nullptr;
    if (napi_create_array_with_length(env, row.columns.size(), &arr) != napi_ok) return nullptr;
    for (size_t i = 0; i < row.columns.size(); ++i) {
        napi_set_element(env, arr, static_cast<uint32_t>(i), adapter.columnToValue(row.columns[i]));
    }
    return arr;
}

napi_value NapiRuntimeAdapter::rowsToArray(const QueryResult& result)
{
    std::vector<napi_value> keys;
    makeKeys(env_, result.columnNames, keys);

    napi_value arr = nullptr;
    if (napi_create_array_with_length(env_, result.rows.size(), &arr) != napi_ok) return nullptr;
    for (size_t i = 0; i < result.rows.size(); ++i) {
        napi_set_element(env_, arr, static_cast<uint32_t>(i),
                         rowToObject(*this, env_, keys, result.rows[i]));
    }
    return arr;
}

napi_value NapiRuntimeAdapter::firstRowOrUndefined(const QueryResult& result)
{
    if (result.rows.empty()) {
        napi_value undef = nullptr;
        napi_get_undefined(env_, &undef);
        return undef;
    }
    std::vector<napi_value> keys;
    makeKeys(env_, result.columnNames, keys);
    return rowToObject(*this, env_, keys, result.rows[0]);
}

napi_value NapiRuntimeAdapter::arrayResultToObject(const QueryResult& result, bool firstRowOnly)
{
    napi_value obj = nullptr;
    if (napi_create_object(env_, &obj) != napi_ok) return nullptr;

    napi_value columns = nullptr;
    if (napi_create_array_with_length(env_, result.columnNames.size(), &columns) != napi_ok) return nullptr;
    for (size_t i = 0; i < result.columnNames.size(); ++i) {
        napi_set_element(env_, columns, static_cast<uint32_t>(i), String(env_, result.columnNames[i]));
    }
    napi_set_named_property(env_, obj, "columns", columns);

    size_t rowCount = firstRowOnly ? (result.rows.empty() ? 0u : 1u) : result.rows.size();
    napi_value rows = nullptr;
    if (napi_create_array_with_length(env_, rowCount, &rows) != napi_ok) return nullptr;
    for (size_t i = 0; i < rowCount; ++i) {
        napi_set_element(env_, rows, static_cast<uint32_t>(i), rowToArray(*this, env_, result.rows[i]));
    }
    napi_set_named_property(env_, obj, "rows", rows);
    return obj;
}

napi_value NapiRuntimeAdapter::runtimeInfoToObject(const RuntimeInfo& info)
{
    napi_value obj = nullptr;
    if (napi_create_object(env_, &obj) != napi_ok) return nullptr;
    napi_set_named_property(env_, obj, "version", String(env_, info.version));
    napi_set_named_property(env_, obj, "sourceId", String(env_, info.sourceId));

    napi_value options = nullptr;
    if (napi_create_array_with_length(env_, info.compileOptions.size(), &options) != napi_ok) return nullptr;
    for (size_t i = 0; i < info.compileOptions.size(); ++i) {
        napi_set_element(env_, options, static_cast<uint32_t>(i), String(env_, info.compileOptions[i]));
    }
    napi_set_named_property(env_, obj, "compileOptions", options);
    return obj;
}

// ── JSON fast path ──────────────────────────────────────────────────────────

bool NapiRuntimeAdapter::init(napi_env env)
{
    env_ = env;

    napi_value global = nullptr;
    napi_value json = nullptr;
    napi_value parse = nullptr;
    if (napi_get_global(env, &global) != napi_ok ||
        napi_get_named_property(env, global, "JSON", &json) != napi_ok ||
        napi_get_named_property(env, json, "parse", &parse) != napi_ok) {
        LogError("[NapiRuntimeAdapter] JSON.parse is unavailable");
        return false;
    }
    if (napi_create_reference(env, json, 1, &json_) != napi_ok ||
        napi_create_reference(env, parse, 1, &jsonParse_) != napi_ok) {
        LogError("[NapiRuntimeAdapter] failed to reference JSON.parse");
        return false;
    }
    return true;
}

napi_value NapiRuntimeAdapter::parseJson(const std::string& json)
{
    napi_value receiver = nullptr;
    napi_value parse = nullptr;
    if (napi_get_reference_value(env_, json_, &receiver) != napi_ok ||
        napi_get_reference_value(env_, jsonParse_, &parse) != napi_ok) {
        return nullptr;
    }

    napi_value arg = String(env_, json);
    if (!arg) return nullptr;

    napi_value parsed = nullptr;
    if (napi_call_function(env_, receiver, parse, 1, &arg, &parsed) != napi_ok) {
        NapiHelpers::ClearPendingException(env_);
        return nullptr;
    }
    return parsed;
}

void NapiRuntimeAdapter::rejectParseFailure(napi_deferred deferred)
{
    napi_value error = NapiHelpers::MakeError(env_, "SQLite JSON result parse error");
    napi_reject_deferred(env_, deferred, error);
}

// Replaces the {"__blob__":N} placeholders JSONBuilder emitted with real
// ArrayBuffers.  Only called when the result carries blobs.

static bool blobIndexOf(napi_env env, napi_value value, napi_value blobKey, int32_t* index)
{
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
    bool isArray = false;
    if (napi_is_array(env, value, &isArray) != napi_ok || isArray) return false;

    napi_value marker = nullptr;
    if (napi_get_property(env, value, blobKey, &marker) != napi_ok) return false;
    return NapiHelpers::IsInt32(env, marker, index);
}

static void hydrateObjectRows(napi_env env,
                              napi_value rows,
                              const std::vector<std::vector<uint8_t>>& blobs)
{
    napi_value blobKey = String(env, "__blob__", 8);
    uint32_t rowCount = 0;
    if (!blobKey || napi_get_array_length(env, rows, &rowCount) != napi_ok) return;

    for (uint32_t r = 0; r < rowCount; ++r) {
        napi_value row = nullptr;
        if (napi_get_element(env, rows, r, &row) != napi_ok) continue;
        napi_valuetype type = napi_undefined;
        if (napi_typeof(env, row, &type) != napi_ok || type != napi_object) continue;
        bool isArray = false;
        if (napi_is_array(env, row, &isArray) != napi_ok || isArray) continue;

        napi_value names = nullptr;
        if (napi_get_all_property_names(env, row, napi_key_own_only,
                                        static_cast<napi_key_filter>(napi_key_enumerable | napi_key_skip_symbols),
                                        napi_key_numbers_to_strings, &names) != napi_ok) {
            continue;
        }
        uint32_t nameCount = 0;
        if (napi_get_array_length(env, names, &nameCount) != napi_ok) continue;

        for (uint32_t p = 0; p < nameCount; ++p) {
            napi_value key = nullptr;
            napi_value value = nullptr;
            if (napi_get_element(env, names, p, &key) != napi_ok) continue;
            if (napi_get_property(env, row, key, &value) != napi_ok) continue;
            int32_t index = 0;
            if (!blobIndexOf(env, value, blobKey, &index)) continue;
            if (index < 0 || static_cast<size_t>(index) >= blobs.size()) continue;
            const auto& blob = blobs[static_cast<size_t>(index)];
            napi_set_property(env, row, key, ArrayBufferFrom(env, blob.data(), blob.size()));
        }
    }
}

static void hydrateArrayRows(napi_env env,
                             napi_value rows,
                             const std::vector<std::vector<uint8_t>>& blobs)
{
    napi_value blobKey = String(env, "__blob__", 8);
    uint32_t rowCount = 0;
    if (!blobKey || napi_get_array_length(env, rows, &rowCount) != napi_ok) return;

    for (uint32_t r = 0; r < rowCount; ++r) {
        napi_value row = nullptr;
        if (napi_get_element(env, rows, r, &row) != napi_ok) continue;
        bool isArray = false;
        if (napi_is_array(env, row, &isArray) != napi_ok || !isArray) continue;

        uint32_t columnCount = 0;
        if (napi_get_array_length(env, row, &columnCount) != napi_ok) continue;
        for (uint32_t c = 0; c < columnCount; ++c) {
            napi_value value = nullptr;
            if (napi_get_element(env, row, c, &value) != napi_ok) continue;
            int32_t index = 0;
            if (!blobIndexOf(env, value, blobKey, &index)) continue;
            if (index < 0 || static_cast<size_t>(index) >= blobs.size()) continue;
            const auto& blob = blobs[static_cast<size_t>(index)];
            napi_set_element(env, row, c, ArrayBufferFrom(env, blob.data(), blob.size()));
        }
    }
}

// Extracts the "rows" array of a columnar result so its blobs can be hydrated.
static napi_value columnarRows(napi_env env, napi_value result)
{
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, result, &type) != napi_ok || type != napi_object) return nullptr;
    napi_value rows = nullptr;
    if (napi_get_named_property(env, result, "rows", &rows) != napi_ok) return nullptr;
    bool isArray = false;
    if (napi_is_array(env, rows, &isArray) != napi_ok || !isArray) return nullptr;
    return rows;
}

// ── Async resolve ───────────────────────────────────────────────────────────

void NapiRuntimeAdapter::resolveWithRows(void* promiseCtx, const QueryResult& result)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);

    napi_value resolved = nullptr;
    if (!result.jsonRows.empty()) {
        resolved = parseJson(result.jsonRows);
        if (!resolved) { rejectParseFailure(deferred); return; }
        bool isArray = false;
        if (!result.jsonBlobs.empty() &&
            napi_is_array(env_, resolved, &isArray) == napi_ok && isArray) {
            hydrateObjectRows(env_, resolved, result.jsonBlobs);
        }
    } else {
        resolved = rowsToArray(result);
    }

    napi_resolve_deferred(env_, deferred, resolved);
}

void NapiRuntimeAdapter::resolveWithFirstRow(void* promiseCtx, const QueryResult& result)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);

    napi_value resolved = nullptr;
    if (!result.jsonRows.empty()) {
        // jsonRows is "[{...}]" with 0 or 1 elements.
        napi_value parsed = parseJson(result.jsonRows);
        if (!parsed) { rejectParseFailure(deferred); return; }

        bool isArray = false;
        uint32_t length = 0;
        if (napi_is_array(env_, parsed, &isArray) == napi_ok && isArray &&
            napi_get_array_length(env_, parsed, &length) == napi_ok && length > 0) {
            if (!result.jsonBlobs.empty()) {
                hydrateObjectRows(env_, parsed, result.jsonBlobs);
            }
            napi_get_element(env_, parsed, 0, &resolved);
        } else {
            napi_get_undefined(env_, &resolved);
        }
    } else {
        resolved = firstRowOrUndefined(result);
    }

    napi_resolve_deferred(env_, deferred, resolved);
}

void NapiRuntimeAdapter::resolveWithArrayResult(void* promiseCtx, const QueryResult& result)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);

    napi_value resolved = nullptr;
    if (!result.jsonRows.empty()) {
        // jsonRows is {"columns":[...],"rows":[[...],...]}
        resolved = parseJson(result.jsonRows);
        if (!resolved) { rejectParseFailure(deferred); return; }
        if (!result.jsonBlobs.empty()) {
            napi_value rows = columnarRows(env_, resolved);
            if (rows) hydrateArrayRows(env_, rows, result.jsonBlobs);
        }
    } else {
        resolved = arrayResultToObject(result, false);
    }

    napi_resolve_deferred(env_, deferred, resolved);
}

void NapiRuntimeAdapter::resolveWithFirstArrayRow(void* promiseCtx, const QueryResult& result)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);

    napi_value resolved = nullptr;
    if (!result.jsonRows.empty()) {
        resolved = parseJson(result.jsonRows);
        if (!resolved) { rejectParseFailure(deferred); return; }
        if (!result.jsonBlobs.empty()) {
            napi_value rows = columnarRows(env_, resolved);
            if (rows) hydrateArrayRows(env_, rows, result.jsonBlobs);
        }
    } else {
        resolved = arrayResultToObject(result, true);
    }

    napi_resolve_deferred(env_, deferred, resolved);
}

void NapiRuntimeAdapter::resolveVoid(void* promiseCtx)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);
    napi_value undef = nullptr;
    napi_get_undefined(env_, &undef);
    napi_resolve_deferred(env_, deferred, undef);
}

void NapiRuntimeAdapter::resolveWithId(void* promiseCtx, uint32_t id)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);
    napi_value value = nullptr;
    napi_create_uint32(env_, id, &value);
    napi_resolve_deferred(env_, deferred, value);
}

void NapiRuntimeAdapter::resolveWithRuntimeInfo(void* promiseCtx, const RuntimeInfo& info)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);
    napi_resolve_deferred(env_, deferred, runtimeInfoToObject(info));
}

void NapiRuntimeAdapter::reject(void* promiseCtx, const std::string& message, int code)
{
    auto deferred = static_cast<napi_deferred>(promiseCtx);
    napi_reject_deferred(env_, deferred, NapiHelpers::MakeError(env_, message, code));
}

// ── Sync return ─────────────────────────────────────────────────────────────

void NapiRuntimeAdapter::returnRows(void* returnCtx, const QueryResult& result)
{
    static_cast<NapiReturn*>(returnCtx)->value = rowsToArray(result);
}

void NapiRuntimeAdapter::returnFirstRow(void* returnCtx, const QueryResult& result)
{
    static_cast<NapiReturn*>(returnCtx)->value = firstRowOrUndefined(result);
}

void NapiRuntimeAdapter::returnArrayResult(void* returnCtx, const QueryResult& result)
{
    static_cast<NapiReturn*>(returnCtx)->value = arrayResultToObject(result, false);
}

void NapiRuntimeAdapter::returnFirstArrayRow(void* returnCtx, const QueryResult& result)
{
    static_cast<NapiReturn*>(returnCtx)->value = arrayResultToObject(result, true);
}

void NapiRuntimeAdapter::returnVoid(void* returnCtx)
{
    auto* out = static_cast<NapiReturn*>(returnCtx);
    napi_get_undefined(env_, &out->value);
}

} // namespace NSCSQLite
