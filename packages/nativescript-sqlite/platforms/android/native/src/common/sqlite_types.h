#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <variant>

// ---------------------------------------------------------------------------
// Runtime-agnostic types — NO V8 / NO JNI anywhere in this file.
// Worker threads produce these; the runtime thread converts them to JS values.
// ---------------------------------------------------------------------------

namespace NSCSQLite
{

    // -- Column value ------------------------------------------------------------

    enum class ColumnType : uint8_t
    {
        Integer = 1,
        Float = 2,
        Text = 3,
        Blob = 4,
        Null = 5,
    };

    struct ColumnValue
    {
        ColumnType type{ColumnType::Null};

        // Plain data members — avoids variant overhead for hot path
        int64_t intValue{0};
        double doubleValue{0.0};
        std::string textValue{};
        std::vector<uint8_t> blobValue{};
    };

    // -- Row ---------------------------------------------------------------------

    struct RowData
    {
        std::vector<ColumnValue> columns; // parallel to QueryResult::columnNames
    };

    // -- Query result -------------------------------------------------------------

    struct QueryResult
    {
        bool success{false};
        std::string error{};
        int errorCode{0}; // SQLite result code on failure

        int64_t insertId{0};
        int rowsAffected{0};

        // --- Structured path (sync API) -----------------------------------------
        std::vector<std::string> columnNames; // ordered column names
        std::vector<RowData> rows;

        // --- JSON fast path (async API) ------------------------------------------
        // Built on the worker thread by runStatementAsJson(); consumed on the JS
        // thread via v8::JSON::Parse() + blob hydration.
        // jsonRows format depends on the query variant:
        //   select / get       → "[{\"col\":val,...}, ...]"
        //   selectArray        → "{\"columns\":[...],\"rows\":[[...],...]}"
        std::string jsonRows{};
        std::vector<std::vector<uint8_t>> jsonBlobs{}; // indexed by __blob__ N
    };

    // -- Bound parameter ---------------------------------------------------------
    // Params are extracted from V8 on the runtime thread, then passed to workers.

    struct BoundParam
    {
        ColumnType type{ColumnType::Null};

        int64_t intValue{0};
        double doubleValue{0.0};
        std::string textValue{};
        std::vector<uint8_t> blobValue{};
        std::string paramName{};
    };

    using ParamList = std::vector<BoundParam>;

    // -- Runtime diagnostics -----------------------------------------------------

    struct RuntimeInfo
    {
        std::string version{};
        std::string sourceId{};
        std::vector<std::string> compileOptions{};
    };

    // -- Open options -------------------------------------------------------------

    struct OpenOptions
    {
        std::string path{};
        bool readOnly{false};
        bool noMutex{false}; // SQLITE_OPEN_NOMUTEX — safe when only one thread accesses this connection; enables stmt cache
        int busyTimeoutMs{5000};
        std::string encryptionKey{}; // maps to PRAGMA key = ?
        int poolSize{0};             // 0 = hardware_concurrency
    };

} // namespace NSCSQLite
