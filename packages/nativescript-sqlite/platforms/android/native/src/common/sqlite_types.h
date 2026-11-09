#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>
#include <variant>

// ---------------------------------------------------------------------------
// Runtime-agnostic types — NO Node-API / NO JNI anywhere in this file.
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
        // thread via JSON.parse() + blob hydration.
        // jsonRows format depends on the query variant:
        //   select / get       → "[{\"col\":val,...}, ...]"
        //   selectArray        → "{\"columns\":[...],\"rows\":[[...],...]}"
        std::string jsonRows{};
        std::vector<std::vector<uint8_t>> jsonBlobs{}; // indexed by __blob__ N
    };

    // -- Bound parameter ---------------------------------------------------------
    // Params are extracted from JS values on the runtime thread, then passed to workers.

    struct BoundParam
    {
        ColumnType type{ColumnType::Null};

        int64_t intValue{0};
        double doubleValue{0.0};
        std::string textValue{};
        std::vector<uint8_t> blobValue{};
        std::string paramName{};
    };

    // A whole number within ±(2^53 - 1) binds as INTEGER, as on iOS: bound as REAL
    // it would be stored as '1.0' in a TEXT-affinity column and no longer equal a
    // stored '1'. -0 stays REAL so its sign survives.
    inline void SetNumberParam(BoundParam &p, double value)
    {
        if (value >= -9007199254740991.0 && value <= 9007199254740991.0 &&
            value == std::trunc(value) && !(value == 0.0 && std::signbit(value)))
        {
            p.type = ColumnType::Integer;
            p.intValue = static_cast<int64_t>(value);
        }
        else
        {
            p.type = ColumnType::Float;
            p.doubleValue = value;
        }
    }

    using ParamList = std::vector<BoundParam>;

    // -- Runtime diagnostics -----------------------------------------------------

    struct RuntimeInfo
    {
        std::string version{};
        std::string sourceId{};
        std::vector<std::string> compileOptions{};
    };

    // -- Open sequence ------------------------------------------------------------
    // The numbers are the wire format the JS layer sends; it resolves and
    // validates the whole sequence, so a connection runs the list as given.

    enum class OpenStepKind : uint8_t
    {
        Sql = 0, // run OpenStep::sql
        Key = 1, // apply OpenOptions::encryptionKey
        Wal = 2, // switch the journal mode to WAL
    };

    enum class OpenStepScope : uint8_t
    {
        All = 0,
        Writer = 1,
        Readers = 2,
    };

    struct OpenStep
    {
        OpenStepKind kind{OpenStepKind::Sql};
        OpenStepScope scope{OpenStepScope::All};
        std::string sql{};
    };

    // -- Open options -------------------------------------------------------------

    struct OpenOptions
    {
        std::string path{};
        bool readOnly{false};
        bool noMutex{false}; // SQLITE_OPEN_NOMUTEX — safe when only one thread accesses this connection; enables stmt cache
        bool isWriter{true}; // which scoped steps of openSequence apply; the serialized connection is the writer
        int busyTimeoutMs{5000};
        // Operand of PRAGMA key, already resolved by the JS layer — the connection
        // quotes it but never reinterprets it.
        std::string encryptionKey{};
        // This connection's whole setup, in order. A step that fails aborts the open.
        std::vector<OpenStep> openSequence{};
        bool queryOnly{false}; // PRAGMA query_only=ON, after the sequence
        int poolSize{0};       // 0 = hardware_concurrency
    };

} // namespace NSCSQLite
