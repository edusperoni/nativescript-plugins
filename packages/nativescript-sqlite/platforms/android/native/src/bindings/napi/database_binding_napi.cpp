#include "../../common/sqlite_connection.h"
#include "../../common/log.h"
#include "../../async/napi_dispatcher.h"
#include "../../runtime/napi/napi_runtime_adapter.h"
#include "../../runtime/napi/napi_helpers.h"

#include <node_api.h>
#include <atomic>
#include <memory>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace NSCSQLite
{
    namespace DatabaseBinding
    {

        struct DBInstance;

        // Everything the module needs that belongs to one env.  Two envs (the main
        // runtime and a Worker) each get their own copy through napi_set_instance_data.
        struct EnvState
        {
            napi_env env{nullptr};
            napi_ref constructor{nullptr};
            NapiRuntimeAdapter adapter;
            NapiCompletionQueue completions;

            // Instances that have not started tearing down.  Touched from the env's
            // thread only.
            std::unordered_set<DBInstance *> live;
        };

        // Pooled mode: every connection is SQLITE_OPEN_NOMUTEX because it is accessed
        // by exactly one thread at a time.  WAL mode (set on the writer) lets readers
        // proceed without blocking writes and writes proceed without blocking readers.
        //
        // Serialized mode: readerDbs/readerDispatchers/syncDb stay empty and writerDb
        // — opened SQLITE_OPEN_FULLMUTEX — serves the dispatcher thread and the JS
        // thread alike, SQLite's own locking making that concurrency safe.
        struct DBInstance
        {
            std::unique_ptr<SQLiteConnection> writerDb;
            std::unique_ptr<NapiDispatcher> writerDispatcher;

            std::vector<std::unique_ptr<SQLiteConnection>> readerDbs;
            std::vector<std::unique_ptr<NapiDispatcher>> readerDispatchers;
            std::atomic<int> readerIndex{0};

            std::unique_ptr<SQLiteConnection> syncDb;

            EnvState *state{nullptr};

            SQLiteConnection *syncConnection() const
            {
                return syncDb ? syncDb.get() : writerDb.get();
            }
        };

        // Closes every connection on its own dispatcher and frees the instance
        // once all of them are done.  deferred is null on the finalizer path.
        // Each dispatcher is a single FIFO thread whose completions drain in
        // order, so by the time the writer's completion runs every completion
        // dispatched before teardown has already run — the one safe point to free
        // the instance (~NapiDispatcher joins its worker before tearing down).
        //
        // Closing a WAL database checkpoints it and unlinks the -wal only for the
        // connection that can take an EXCLUSIVE file lock, i.e. the last one still
        // attached. Closing the pool in parallel leaves each connection seeing the
        // others, so none of them checkpoints; the writer therefore closes alone,
        // after every reader is gone.
        static void Teardown(DBInstance *instance, napi_deferred deferred)
        {
            instance->state->live.erase(instance);

            // Sync connection is JS-thread-only; close it immediately.
            if (instance->syncDb)
                instance->syncDb->close();

            int total = 1 + static_cast<int>(instance->readerDispatchers.size());
            auto latch = std::make_shared<std::atomic<int>>(total);
            auto tick = [instance, deferred, latch]()
            {
                if (latch->fetch_sub(1, std::memory_order_acq_rel) == 1)
                {
                    if (deferred)
                        instance->state->adapter.resolveVoid(deferred);
                    delete instance;
                }
            };

            for (size_t i = 0; i < instance->readerDispatchers.size(); ++i)
            {
                SQLiteConnection *rdb = instance->readerDbs[i].get();
                instance->readerDispatchers[i]->dispatch([rdb]()
                                                         { rdb->close(); }, tick);
            }

            SQLiteConnection *wdb = instance->writerDb.get();
            instance->writerDispatcher->dispatch([wdb]()
                                                 { wdb->close(); }, tick);
        }

        static void FinalizeInstance(napi_env /*env*/, void *data, void *hint)
        {
            auto *state = static_cast<EnvState *>(hint);
            auto *instance = static_cast<DBInstance *>(data);
            // The env cleanup hook may already have freed it.
            if (state->live.find(instance) == state->live.end())
                return;
            Teardown(instance, nullptr);
        }

        static void CleanupEnv(void *arg)
        {
            auto *state = static_cast<EnvState *>(arg);
            // Completions can no longer reach JS, so the deferred teardown would never
            // finish: destroy the instances here instead, which joins every dispatcher
            // thread and closes every connection.
            std::unordered_set<DBInstance *> live;
            live.swap(state->live);
            for (DBInstance *instance : live)
                delete instance;
            state->completions.shutdown();
        }

        static void FinalizeEnvState(napi_env /*env*/, void *data, void * /*hint*/)
        {
            delete static_cast<EnvState *>(data);
        }

        // closedResult null marks a synchronous entry point: a closed database throws
        // instead of handing back a rejected promise.
        static DBInstance *GetInstance(napi_env env, napi_value self, napi_value *closedResult)
        {
            DBInstance *instance = nullptr;
            if (napi_unwrap(env, self, reinterpret_cast<void **>(&instance)) == napi_ok && instance)
                return instance;

            NapiHelpers::ClearPendingException(env);

            napi_value error = NapiHelpers::MakeError(env, "database is closed", SQLITE_MISUSE);
            if (!closedResult)
            {
                napi_throw(env, error);
                return nullptr;
            }

            napi_deferred deferred = nullptr;
            napi_value promise = nullptr;
            if (napi_create_promise(env, &deferred, &promise) == napi_ok)
            {
                napi_reject_deferred(env, deferred, error);
                *closedResult = promise;
            }
            return nullptr;
        }

        static void ThrowSQLiteError(napi_env env, const std::string &message, int code)
        {
            napi_throw(env, NapiHelpers::MakeError(env, message, code));
        }

        // Argument slots past argc are filled with undefined, so every accessor below
        // can read its slot unconditionally.
        struct Call
        {
            napi_value self{nullptr};
            size_t argc{0};
            napi_value argv[4]{};
        };

        static bool ReadCall(napi_env env, napi_callback_info info, Call &call)
        {
            call.argc = 4;
            return napi_get_cb_info(env, info, &call.argc, call.argv, &call.self, nullptr) == napi_ok;
        }

        static std::string StringArg(napi_env env, napi_value value)
        {
            std::string out;
            NapiHelpers::ToStdString(env, value, out);
            return out;
        }

        static uint32_t Uint32Arg(napi_env env, napi_value value)
        {
            uint32_t out = 0;
            napi_get_value_uint32(env, value, &out);
            return out;
        }

        static int32_t Int32Arg(napi_env env, napi_value value, int32_t fallback)
        {
            int32_t out = fallback;
            if (napi_get_value_int32(env, value, &out) != napi_ok)
                return fallback;
            return out;
        }

        // Discriminating order mirrors the column types SQLite can bind: Number
        // (integral and int32-representable → Integer, otherwise Float), String,
        // Boolean, ArrayBuffer, everything else Null.
        static BoundParam ParseSingleParam(napi_env env, napi_value item)
        {
            BoundParam p;
            napi_valuetype type = napi_undefined;
            if (napi_typeof(env, item, &type) != napi_ok)
            {
                p.type = ColumnType::Null;
                return p;
            }

            switch (type)
            {
            case napi_number:
            {
                double number = 0.0;
                napi_get_value_double(env, item, &number);
                int32_t asInt = 0;
                if (NapiHelpers::IsInt32Value(number, &asInt))
                {
                    p.type = ColumnType::Integer;
                    p.intValue = asInt;
                }
                else
                {
                    p.type = ColumnType::Float;
                    p.doubleValue = number;
                }
                return p;
            }
            case napi_string:
                p.type = ColumnType::Text;
                NapiHelpers::ToStdString(env, item, p.textValue);
                return p;
            case napi_boolean:
            {
                bool flag = false;
                napi_get_value_bool(env, item, &flag);
                p.type = ColumnType::Integer;
                p.intValue = flag ? 1 : 0;
                return p;
            }
            case napi_object:
            {
                bool isArrayBuffer = false;
                if (napi_is_arraybuffer(env, item, &isArrayBuffer) == napi_ok && isArrayBuffer &&
                    NapiHelpers::ArrayBufferTo(env, item, p.blobValue))
                {
                    p.type = ColumnType::Blob;
                    return p;
                }
                p.type = ColumnType::Null;
                return p;
            }
            default:
                p.type = ColumnType::Null;
                return p;
            }
        }

        // Accepts positional arrays or named-parameter objects.
        // Object keys without a recognized prefix (:/$/@) get ':' prepended automatically,
        static ParamList ParseParams(napi_env env, napi_value value)
        {
            ParamList result;

            napi_valuetype type = napi_undefined;
            if (napi_typeof(env, value, &type) != napi_ok)
                return result;
            if (type == napi_null || type == napi_undefined)
                return result;

            bool isArray = false;
            if (napi_is_array(env, value, &isArray) == napi_ok && isArray)
            {
                uint32_t length = 0;
                napi_get_array_length(env, value, &length);
                result.reserve(length);
                for (uint32_t i = 0; i < length; ++i)
                {
                    napi_value item = nullptr;
                    if (napi_get_element(env, value, i, &item) != napi_ok)
                        continue;
                    result.push_back(ParseSingleParam(env, item));
                }
                return result;
            }

            if (type != napi_object)
                return result;

            napi_value names = nullptr;
            auto filter = static_cast<napi_key_filter>(napi_key_enumerable | napi_key_skip_symbols);
            if (napi_get_all_property_names(env, value, napi_key_own_only, filter,
                                            napi_key_numbers_to_strings, &names) != napi_ok)
            {
                return result;
            }

            uint32_t count = 0;
            napi_get_array_length(env, names, &count);
            result.reserve(count);
            for (uint32_t i = 0; i < count; ++i)
            {
                napi_value key = nullptr;
                napi_value item = nullptr;
                if (napi_get_element(env, names, i, &key) != napi_ok)
                    continue;
                if (napi_get_property(env, value, key, &item) != napi_ok)
                    continue;

                std::string name;
                NapiHelpers::ToStdString(env, key, name);
                if (name.empty() || (name[0] != ':' && name[0] != '$' && name[0] != '@'))
                {
                    name = ':' + name;
                }
                BoundParam p = ParseSingleParam(env, item);
                p.paramName = std::move(name);
                result.push_back(std::move(p));
            }
            return result;
        }

        //  Construction / teardown

        static napi_value Construct(napi_env env, napi_callback_info info)
        {
            Call call;
            call.argc = 4;
            void *data = nullptr;
            if (napi_get_cb_info(env, info, &call.argc, call.argv, &call.self, &data) != napi_ok)
                return nullptr;

            napi_valuetype pathType = napi_undefined;
            if (call.argc < 1 || napi_typeof(env, call.argv[0], &pathType) != napi_ok || pathType != napi_string)
            {
                napi_throw_type_error(env, nullptr, "Expected path string as first argument");
                return nullptr;
            }

            auto *state = static_cast<EnvState *>(data);
            if (!state)
            {
                napi_throw_error(env, nullptr, "NSCSQLite is not initialised for this runtime");
                return nullptr;
            }

            OpenOptions opts;
            opts.path = StringArg(env, call.argv[0]);
            bool serialized = false;

            napi_valuetype optionsType = napi_undefined;
            if (napi_typeof(env, call.argv[1], &optionsType) == napi_ok && optionsType == napi_object)
            {
                napi_value options = call.argv[1];
                napi_value value = nullptr;
                napi_valuetype valueType = napi_undefined;

                if (napi_get_named_property(env, options, "readOnly", &value) == napi_ok &&
                    napi_typeof(env, value, &valueType) == napi_ok && valueType == napi_boolean)
                {
                    napi_get_value_bool(env, value, &opts.readOnly);
                }

                int32_t asInt = 0;
                if (napi_get_named_property(env, options, "poolSize", &value) == napi_ok &&
                    NapiHelpers::IsInt32(env, value, &asInt))
                {
                    opts.poolSize = asInt;
                }

                if (napi_get_named_property(env, options, "busyTimeout", &value) == napi_ok &&
                    NapiHelpers::IsInt32(env, value, &asInt))
                {
                    opts.busyTimeoutMs = asInt;
                }

                if (napi_get_named_property(env, options, "encryptionKey", &value) == napi_ok &&
                    napi_typeof(env, value, &valueType) == napi_ok && valueType == napi_string)
                {
                    NapiHelpers::ToStdString(env, value, opts.encryptionKey);
                }

                bool isArray = false;
                if (napi_get_named_property(env, options, "onOpen", &value) == napi_ok &&
                    napi_is_array(env, value, &isArray) == napi_ok && isArray)
                {
                    uint32_t length = 0;
                    napi_get_array_length(env, value, &length);
                    opts.onOpen.reserve(length);
                    for (uint32_t i = 0; i < length; ++i)
                    {
                        napi_value item = nullptr;
                        if (napi_get_element(env, value, i, &item) != napi_ok)
                            continue;
                        if (napi_typeof(env, item, &valueType) != napi_ok || valueType != napi_string)
                            continue;
                        std::string stmt;
                        NapiHelpers::ToStdString(env, item, stmt);
                        if (!stmt.empty())
                            opts.onOpen.push_back(std::move(stmt));
                    }
                }

                if (napi_get_named_property(env, options, "serialized", &value) == napi_ok &&
                    napi_typeof(env, value, &valueType) == napi_ok && valueType == napi_boolean)
                {
                    napi_get_value_bool(env, value, &serialized);
                }
            }

            int poolSize = opts.poolSize > 0 ? opts.poolSize : 4;

            // Destroying the unique_ptr on any failure below closes every connection
            // already opened and joins every dispatcher already started.
            auto instance = std::make_unique<DBInstance>();
            instance->state = state;

            // Serialized: FULLMUTEX, because the JS thread runs the sync methods
            // straight on this connection while the dispatcher thread uses it too.
            // Pooled: NOMUTEX, exclusively owned by the writer thread.
            OpenOptions writerOpts = opts;
            writerOpts.noMutex = !serialized;
            writerOpts.journalWAL = !opts.readOnly;
            instance->writerDb = std::make_unique<SQLiteConnection>(writerOpts);
            if (!instance->writerDb->isOpen())
            {
                ThrowSQLiteError(env, instance->writerDb->lastError(), instance->writerDb->lastCode());
                return nullptr;
            }
            instance->writerDispatcher = std::make_unique<NapiDispatcher>(state->completions, 1);

            if (!serialized)
            {
                // Readers (NOMUTEX + query_only, one dedicated thread each)
                // Open as READWRITE so each connection can initialise WAL shared memory;
                // PRAGMA query_only=ON prevents accidental writes through reader connections.
                for (int i = 0; i < poolSize; ++i)
                {
                    OpenOptions readerOpts = opts;
                    readerOpts.noMutex = true;
                    readerOpts.queryOnly = !opts.readOnly;
                    auto readerDb = std::make_unique<SQLiteConnection>(readerOpts);
                    if (!readerDb->isOpen())
                    {
                        ThrowSQLiteError(env, readerDb->lastError(), readerDb->lastCode());
                        return nullptr;
                    }
                    instance->readerDbs.push_back(std::move(readerDb));
                    instance->readerDispatchers.push_back(
                        std::make_unique<NapiDispatcher>(state->completions, 1));
                }

                // Sync connection (NOMUTEX, JS thread only)
                OpenOptions syncOpts = opts;
                syncOpts.noMutex = true;
                syncOpts.journalWAL = !opts.readOnly;
                instance->syncDb = std::make_unique<SQLiteConnection>(syncOpts);
                if (!instance->syncDb->isOpen())
                {
                    ThrowSQLiteError(env, instance->syncDb->lastError(), instance->syncDb->lastCode());
                    return nullptr;
                }
            }

            DBInstance *raw = instance.get();
            if (napi_wrap(env, call.self, raw, FinalizeInstance, state, nullptr) != napi_ok)
            {
                napi_throw_error(env, nullptr, "Failed to attach the SQLite instance");
                return nullptr;
            }
            state->live.insert(raw);
            instance.release();
            return call.self;
        }

        static napi_value Close(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;

            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            // Removing the wrap is what makes later calls report a closed database,
            // and it keeps the finalizer from tearing the instance down a second time.
            void *removed = nullptr;
            napi_remove_wrap(env, call.self, &removed);

            napi_deferred deferred = nullptr;
            napi_value promise = nullptr;
            if (napi_create_promise(env, &deferred, &promise) != napi_ok)
                return nullptr;

            Teardown(instance, deferred);
            return promise;
        }

        // Dispatch work to the given dispatcher; resolve or reject the Promise on the
        // env's thread once the completion drains.
        // F1: () -> QueryResult      (runs on a worker thread — MUST NOT touch Node-API)
        // F2: (DBInstance*, napi_deferred, const QueryResult&) -> void  (env's thread)
        // Capturing `instance` raw is safe: Close() frees it only from the last
        // completion, which is queued behind everything dispatched before it.
        template <typename F1, typename F2>
        static napi_value Dispatch(NapiDispatcher &dispatcher, DBInstance *instance,
                                   napi_env env, F1 work, F2 completion)
        {
            napi_deferred deferred = nullptr;
            napi_value promise = nullptr;
            if (napi_create_promise(env, &deferred, &promise) != napi_ok)
                return nullptr;

            auto resultPtr = std::make_shared<QueryResult>();

            dispatcher.dispatch(
                [work = std::move(work), resultPtr]() mutable
                {
                    *resultPtr = work();
                },
                [instance, deferred, completion = std::move(completion), resultPtr]()
                {
                    if (resultPtr->success)
                    {
                        completion(instance, deferred, *resultPtr);
                    }
                    else
                    {
                        instance->state->adapter.reject(deferred, resultPtr->error, resultPtr->errorCode);
                    }
                });

            return promise;
        }

        // Round-robin reader selection; serialized mode has no pool and reads on
        // the writer.
        static std::pair<NapiDispatcher *, SQLiteConnection *> NextReader(DBInstance *instance)
        {
            int n = static_cast<int>(instance->readerDispatchers.size());
            if (n == 0)
                return {instance->writerDispatcher.get(), instance->writerDb.get()};
            int idx = instance->readerIndex.fetch_add(1, std::memory_order_relaxed) % n;
            return {instance->readerDispatchers[idx].get(), instance->readerDbs[idx].get()};
        }

        //  Async methods

        static napi_value AsyncExecute(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, sql, params = std::move(params)]() -> QueryResult
                            { return wdb->execute(sql, params); }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &)
                            { inst->state->adapter.resolveVoid(deferred); });
        }

        static napi_value AsyncSelect(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            auto reader = NextReader(instance);
            SQLiteConnection *rdb = reader.second;
            return Dispatch(*reader.first, instance, env, [rdb, sql, params = std::move(params)]() -> QueryResult
                            { return rdb->executeJson(sql, params); }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            { inst->state->adapter.resolveWithRows(deferred, res); });
        }

        static napi_value AsyncSelectArray(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            auto reader = NextReader(instance);
            SQLiteConnection *rdb = reader.second;
            return Dispatch(*reader.first, instance, env, [rdb, sql, params = std::move(params)]() -> QueryResult
                            { return rdb->executeArrayJson(sql, params); }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            { inst->state->adapter.resolveWithArrayResult(deferred, res); });
        }

        static napi_value AsyncGet(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            auto reader = NextReader(instance);
            SQLiteConnection *rdb = reader.second;
            return Dispatch(*reader.first, instance, env, [rdb, sql, params = std::move(params)]() -> QueryResult
                            { return rdb->executeGetJson(sql, params); }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            { inst->state->adapter.resolveWithFirstRow(deferred, res); });
        }

        static napi_value AsyncGetArray(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            auto reader = NextReader(instance);
            SQLiteConnection *rdb = reader.second;
            return Dispatch(*reader.first, instance, env, [rdb, sql, params = std::move(params)]() -> QueryResult
                            { return rdb->executeGetArrayJson(sql, params); }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            { inst->state->adapter.resolveWithFirstArrayRow(deferred, res); });
        }

        //  Sync Methods

        static napi_value SyncExecute(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            DBInstance *instance = GetInstance(env, call.self, nullptr);
            if (!instance)
                return nullptr;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            QueryResult res = instance->syncConnection()->execute(sql, params);
            if (!res.success)
            {
                ThrowSQLiteError(env, res.error, res.errorCode);
                return nullptr;
            }

            NapiReturn out{env, nullptr};
            instance->state->adapter.returnVoid(&out);
            return out.value;
        }

        static napi_value SyncSelect(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            DBInstance *instance = GetInstance(env, call.self, nullptr);
            if (!instance)
                return nullptr;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            QueryResult res = instance->syncConnection()->execute(sql, params);
            if (!res.success)
            {
                ThrowSQLiteError(env, res.error, res.errorCode);
                return nullptr;
            }

            NapiReturn out{env, nullptr};
            instance->state->adapter.returnRows(&out, res);
            return out.value;
        }

        static napi_value SyncSelectArray(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            DBInstance *instance = GetInstance(env, call.self, nullptr);
            if (!instance)
                return nullptr;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            QueryResult res = instance->syncConnection()->execute(sql, params);
            if (!res.success)
            {
                ThrowSQLiteError(env, res.error, res.errorCode);
                return nullptr;
            }

            NapiReturn out{env, nullptr};
            instance->state->adapter.returnArrayResult(&out, res);
            return out.value;
        }

        static napi_value SyncGet(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            DBInstance *instance = GetInstance(env, call.self, nullptr);
            if (!instance)
                return nullptr;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            QueryResult res = instance->syncConnection()->executeGet(sql, params);
            if (!res.success)
            {
                ThrowSQLiteError(env, res.error, res.errorCode);
                return nullptr;
            }

            NapiReturn out{env, nullptr};
            instance->state->adapter.returnFirstRow(&out, res);
            return out.value;
        }

        static napi_value SyncGetArray(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            DBInstance *instance = GetInstance(env, call.self, nullptr);
            if (!instance)
                return nullptr;

            std::string sql = StringArg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            QueryResult res = instance->syncConnection()->executeGet(sql, params);
            if (!res.success)
            {
                ThrowSQLiteError(env, res.error, res.errorCode);
                return nullptr;
            }

            NapiReturn out{env, nullptr};
            instance->state->adapter.returnFirstArrayRow(&out, res);
            return out.value;
        }

        //  Prepared Statements

        static napi_value Prepare(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            std::string sql = StringArg(env, call.argv[0]);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, sql]() -> QueryResult
                            {
            uint32_t stmtId = wdb->prepareStatement(sql);
            QueryResult res;
            if (stmtId > 0) {
                res.success  = true;
                res.insertId = stmtId;
            } else {
                res = wdb->errorResult();
            }
            return res; }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            { inst->state->adapter.resolveWithId(deferred, static_cast<uint32_t>(res.insertId)); });
        }

        static napi_value StepStatement(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            uint32_t stmtId = Uint32Arg(env, call.argv[0]);
            ParamList params = ParseParams(env, call.argv[1]);

            // Mode: 0=execute, 1=select, 2=selectArray, 3=get, 4=getArray
            int mode = Int32Arg(env, call.argv[2], 0);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, stmtId, params = std::move(params), mode]() -> QueryResult
                            {
            if (mode == 1) return wdb->stepStatementJson(stmtId, params, false);
            if (mode == 2) return wdb->stepStatementArrayJson(stmtId, params, false);
            if (mode == 3) return wdb->stepStatementJson(stmtId, params, true);
            if (mode == 4) return wdb->stepStatementArrayJson(stmtId, params, true);
            return wdb->stepStatement(stmtId, params); }, [mode](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            {
            if (mode == 0) inst->state->adapter.resolveVoid(deferred);
            else if (mode == 1) inst->state->adapter.resolveWithRows(deferred, res);
            else if (mode == 2) inst->state->adapter.resolveWithArrayResult(deferred, res);
            else if (mode == 3) inst->state->adapter.resolveWithFirstRow(deferred, res);
            else if (mode == 4) inst->state->adapter.resolveWithFirstArrayRow(deferred, res); });
        }

        static napi_value FinalizeStatement(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            uint32_t stmtId = Uint32Arg(env, call.argv[0]);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, stmtId]() -> QueryResult
                            {
            wdb->finalizeStatement(stmtId);
            QueryResult res;
            res.success = true;
            return res; }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &)
                            { inst->state->adapter.resolveVoid(deferred); });
        }

        //  Transactions

        static napi_value BeginTransaction(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            TxBehavior behavior = TxBehavior::Deferred;
            napi_valuetype type = napi_undefined;
            if (napi_typeof(env, call.argv[0], &type) == napi_ok && type == napi_string)
            {
                std::string b = StringArg(env, call.argv[0]);
                if (b == "immediate")
                    behavior = TxBehavior::Immediate;
                else if (b == "exclusive")
                    behavior = TxBehavior::Exclusive;
            }

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, behavior]() -> QueryResult
                            {
            uint32_t txId = wdb->beginTransaction(behavior);
            QueryResult res;
            if (txId > 0) {
                res.success  = true;
                res.insertId = txId;
            } else {
                res = wdb->errorResult();
            }
            return res; }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            { inst->state->adapter.resolveWithId(deferred, static_cast<uint32_t>(res.insertId)); });
        }

        static napi_value CommitTransaction(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            uint32_t txId = Uint32Arg(env, call.argv[0]);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, txId]() -> QueryResult
                            {
            wdb->commitTransaction(txId);
            QueryResult res;
            res.success = true;
            return res; }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &)
                            { inst->state->adapter.resolveVoid(deferred); });
        }

        static napi_value RollbackTransaction(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            uint32_t txId = Uint32Arg(env, call.argv[0]);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, txId]() -> QueryResult
                            {
            wdb->rollbackTransaction(txId);
            QueryResult res;
            res.success = true;
            return res; }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &)
                            { inst->state->adapter.resolveVoid(deferred); });
        }

        static napi_value ExecuteInTransaction(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            uint32_t txId = Uint32Arg(env, call.argv[0]);
            std::string sql = StringArg(env, call.argv[1]);
            ParamList params = ParseParams(env, call.argv[2]);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, txId, sql, params = std::move(params)]() -> QueryResult
                            { return wdb->executeInTransaction(txId, sql, params); }, [](DBInstance *inst, napi_deferred deferred, const QueryResult &)
                            { inst->state->adapter.resolveVoid(deferred); });
        }

        static napi_value SelectInTransaction(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            napi_value closed = nullptr;
            DBInstance *instance = GetInstance(env, call.self, &closed);
            if (!instance)
                return closed;

            uint32_t txId = Uint32Arg(env, call.argv[0]);
            std::string sql = StringArg(env, call.argv[1]);
            ParamList params = ParseParams(env, call.argv[2]);

            // Mode: 1=select, 2=selectArray
            int mode = Int32Arg(env, call.argv[3], 1);

            SQLiteConnection *wdb = instance->writerDb.get();
            return Dispatch(*instance->writerDispatcher, instance, env, [wdb, txId, sql, params = std::move(params), mode]() -> QueryResult
                            {
            if (mode == 2) return wdb->selectInTransactionArrayJson(txId, sql, params);
            return wdb->selectInTransactionJson(txId, sql, params); }, [mode](DBInstance *inst, napi_deferred deferred, const QueryResult &res)
                            {
            if (mode == 2) inst->state->adapter.resolveWithArrayResult(deferred, res);
            else           inst->state->adapter.resolveWithRows(deferred, res); });
        }

        static napi_value GetRuntimeInfo(napi_env env, napi_callback_info info)
        {
            Call call;
            if (!ReadCall(env, info, call))
                return nullptr;
            DBInstance *instance = GetInstance(env, call.self, nullptr);
            if (!instance)
                return nullptr;

            return instance->state->adapter.runtimeInfoToObject(instance->writerDb->getRuntimeInfo());
        }

        //  Initialization

        static napi_value Init(napi_env env, napi_value exports)
        {
            auto state = std::make_unique<EnvState>();
            state->env = env;
            if (!state->adapter.init(env) || !state->completions.init(env))
            {
                napi_throw_error(env, nullptr, "Failed to initialise NSCSQLite for this runtime");
                return nullptr;
            }

            const napi_property_descriptor methods[] = {
                {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"execute", nullptr, AsyncExecute, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"select", nullptr, AsyncSelect, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"selectArray", nullptr, AsyncSelectArray, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"get", nullptr, AsyncGet, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"getArray", nullptr, AsyncGetArray, nullptr, nullptr, nullptr, napi_default_method, nullptr},

                {"executeSync", nullptr, SyncExecute, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"selectSync", nullptr, SyncSelect, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"selectArraySync", nullptr, SyncSelectArray, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"getSync", nullptr, SyncGet, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"getArraySync", nullptr, SyncGetArray, nullptr, nullptr, nullptr, napi_default_method, nullptr},

                {"prepare", nullptr, Prepare, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"stepStatement", nullptr, StepStatement, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"finalizeStatement", nullptr, FinalizeStatement, nullptr, nullptr, nullptr, napi_default_method, nullptr},

                {"beginTransaction", nullptr, BeginTransaction, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"commitTransaction", nullptr, CommitTransaction, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"rollbackTransaction", nullptr, RollbackTransaction, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"executeInTransaction", nullptr, ExecuteInTransaction, nullptr, nullptr, nullptr, napi_default_method, nullptr},
                {"selectInTransaction", nullptr, SelectInTransaction, nullptr, nullptr, nullptr, napi_default_method, nullptr},

                {"getRuntimeInfo", nullptr, GetRuntimeInfo, nullptr, nullptr, nullptr, napi_default_method, nullptr},
            };

            napi_value constructor = nullptr;
            if (napi_define_class(env, "NSCSQLite", NAPI_AUTO_LENGTH, Construct, state.get(),
                                  sizeof(methods) / sizeof(methods[0]), methods, &constructor) != napi_ok ||
                napi_create_reference(env, constructor, 1, &state->constructor) != napi_ok ||
                napi_set_named_property(env, exports, "NSCSQLite", constructor) != napi_ok)
            {
                napi_throw_error(env, nullptr, "Failed to define the NSCSQLite class");
                return nullptr;
            }

            EnvState *raw = state.release();
            napi_set_instance_data(env, raw, FinalizeEnvState, nullptr);
            napi_add_env_cleanup_hook(env, CleanupEnv, raw);
            return exports;
        }

    } // namespace DatabaseBinding
} // namespace NSCSQLite

// The runtime resolves `require("nscsqlite")` through this registration; the
// constructor runs when System.loadLibrary() loads the library.
static napi_module sNSCSQLiteModule = {
    NAPI_MODULE_VERSION,
    0,
    __FILE__,
    NSCSQLite::DatabaseBinding::Init,
    "nscsqlite",
    nullptr,
    {nullptr, nullptr, nullptr, nullptr},
};

__attribute__((constructor)) static void RegisterNSCSQLiteModule(void)
{
    napi_module_register(&sNSCSQLiteModule);
}
