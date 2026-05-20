#include "database_binding.h"
#include "../common/sqlite_connection.h"
#include "../async/android_dispatcher.h"
#include "../runtime/v8/v8_runtime_adapter.h"
#include "../runtime/v8/v8_helpers.h"

#include <atomic>
#include <memory>
#include <vector>

namespace NSCSQLite
{
    namespace DatabaseBinding
    {

        // Each connection is SQLITE_OPEN_NOMUTEX because it is accessed by exactly one
        // thread at a time.  WAL mode (set on the writer) lets readers proceed without
        // blocking writes and writes proceed without blocking readers.
        struct DBInstance
        {
            std::unique_ptr<SQLiteConnection> writerDb;
            std::unique_ptr<AndroidDispatcher> writerDispatcher;

            std::vector<std::unique_ptr<SQLiteConnection>> readerDbs;
            std::vector<std::unique_ptr<AndroidDispatcher>> readerDispatchers;
            std::atomic<int> readerIndex{0};

            std::unique_ptr<SQLiteConnection> syncDb;

            std::unique_ptr<V8RuntimeAdapter> adapter;
            v8::Isolate *isolate;
        };

        static DBInstance *GetInstance(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto ext = args.This()->GetInternalField(0).As<v8::External>();
            return static_cast<DBInstance *>(ext->Value());
        }

        static BoundParam ParseSingleParam(v8::Isolate *isolate,
                                           v8::Local<v8::Context> ctx,
                                           v8::Local<v8::Value> item)
        {
            BoundParam p;
            if (item->IsInt32())
            {
                p.type = ColumnType::Integer;
                p.intValue = item->Int32Value(ctx).ToChecked();
            }
            else if (item->IsNumber())
            {
                p.type = ColumnType::Float;
                p.doubleValue = item->NumberValue(ctx).ToChecked();
            }
            else if (item->IsString())
            {
                p.type = ColumnType::Text;
                p.textValue = V8Helpers::FromV8String(isolate, item);
            }
            else if (item->IsArrayBuffer())
            {
                p.type = ColumnType::Blob;
                p.blobValue = V8Helpers::FromV8ArrayBuffer(isolate, item.As<v8::ArrayBuffer>());
            }
            else if (item->IsBoolean())
            {
                p.type = ColumnType::Integer;
                p.intValue = item->BooleanValue(isolate) ? 1 : 0;
            }
            else
            {
                p.type = ColumnType::Null;
            }
            return p;
        }

        // Accepts positional arrays or named-parameter objects.
        // Object keys without a recognized prefix (:/$/@) get ':' prepended automatically,
        static ParamList ParseParams(v8::Isolate *isolate, v8::Local<v8::Value> val)
        {
            ParamList result;
            if (val.IsEmpty() || val->IsNull() || val->IsUndefined())
                return result;

            auto ctx = isolate->GetCurrentContext();

            if (val->IsArray())
            {
                auto arr = val.As<v8::Array>();
                uint32_t len = arr->Length();
                result.reserve(len);
                for (uint32_t i = 0; i < len; ++i)
                {
                    result.push_back(ParseSingleParam(isolate, ctx, arr->Get(ctx, i).ToLocalChecked()));
                }
                return result;
            }

            if (val->IsObject())
            {
                auto obj = val.As<v8::Object>();
                auto keys = obj->GetOwnPropertyNames(ctx).ToLocalChecked();
                uint32_t len = keys->Length();
                result.reserve(len);
                for (uint32_t i = 0; i < len; ++i)
                {
                    auto key = keys->Get(ctx, i).ToLocalChecked();
                    auto value = obj->Get(ctx, key).ToLocalChecked();
                    std::string name = V8Helpers::FromV8String(isolate, key);
                    if (name.empty() || (name[0] != ':' && name[0] != '$' && name[0] != '@'))
                    {
                        name = ':' + name;
                    }
                    BoundParam p = ParseSingleParam(isolate, ctx, value);
                    p.paramName = std::move(name);
                    result.push_back(std::move(p));
                }
                return result;
            }

            return result;
        }

        // V8 Callbacks

        static void Open(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            v8::Isolate *isolate = args.GetIsolate();
            auto ctx = isolate->GetCurrentContext();

            if (args.Length() < 1 || !args[0]->IsString())
            {
                isolate->ThrowException(v8::Exception::TypeError(V8Helpers::ToV8String(isolate, "Expected path string as first argument")));
                return;
            }

            OpenOptions opts;
            opts.path = V8Helpers::FromV8String(isolate, args[0]);

            if (args.Length() > 1 && args[1]->IsObject())
            {
                auto optionsObj = args[1].As<v8::Object>();
                auto readOnlyVal = optionsObj->Get(ctx, V8Helpers::ToV8String(isolate, "readOnly")).ToLocalChecked();
                if (readOnlyVal->IsBoolean())
                    opts.readOnly = readOnlyVal->BooleanValue(isolate);

                auto poolSizeVal = optionsObj->Get(ctx, V8Helpers::ToV8String(isolate, "poolSize")).ToLocalChecked();
                if (poolSizeVal->IsInt32())
                    opts.poolSize = poolSizeVal->Int32Value(ctx).ToChecked();

                auto busyTimeoutVal = optionsObj->Get(ctx, V8Helpers::ToV8String(isolate, "busyTimeout")).ToLocalChecked();
                if (busyTimeoutVal->IsInt32())
                    opts.busyTimeoutMs = busyTimeoutVal->Int32Value(ctx).ToChecked();

                auto encKeyVal = optionsObj->Get(ctx, V8Helpers::ToV8String(isolate, "encryptionKey")).ToLocalChecked();
                if (encKeyVal->IsString())
                    opts.encryptionKey = V8Helpers::FromV8String(isolate, encKeyVal);
            }

            int poolSize = opts.poolSize > 0 ? opts.poolSize : 4;

            auto instance = std::make_unique<DBInstance>();
            instance->isolate = isolate;
            instance->adapter = std::make_unique<V8RuntimeAdapter>(isolate);

            // Writer (NOMUTEX — exclusively owned by the writer thread)
            // SQLiteConnection constructor sets PRAGMA journal_mode=WAL on the writer.
            OpenOptions writerOpts = opts;
            writerOpts.noMutex = true;
            instance->writerDb = std::make_unique<SQLiteConnection>(writerOpts);
            if (!instance->writerDb->isOpen())
            {
                isolate->ThrowException(v8::Exception::Error(
                    V8Helpers::ToV8String(isolate, instance->writerDb->lastError())));
                return;
            }
            instance->writerDispatcher = std::make_unique<AndroidDispatcher>(1);
            instance->writerDispatcher->attachToRuntimeThread(isolate);

            // Readers (NOMUTEX + query_only, one dedicated thread each)
            // Open as READWRITE so each connection can initialise WAL shared memory;
            // PRAGMA query_only=ON prevents accidental writes through reader connections.
            for (int i = 0; i < poolSize; ++i)
            {
                OpenOptions readerOpts = opts;
                readerOpts.noMutex = true;
                auto readerDb = std::make_unique<SQLiteConnection>(readerOpts);
                if (!readerDb->isOpen())
                {
                    isolate->ThrowException(v8::Exception::Error(
                        V8Helpers::ToV8String(isolate, readerDb->lastError())));
                    return;
                }
                if (!opts.readOnly)
                {
                    readerDb->execute("PRAGMA query_only=ON", {});
                }
                instance->readerDbs.push_back(std::move(readerDb));

                auto readerDispatcher = std::make_unique<AndroidDispatcher>(1);
                readerDispatcher->attachToRuntimeThread(isolate);
                instance->readerDispatchers.push_back(std::move(readerDispatcher));
            }

            // Sync connection (NOMUTEX, JS thread only)
            OpenOptions syncOpts = opts;
            syncOpts.noMutex = true;
            instance->syncDb = std::make_unique<SQLiteConnection>(syncOpts);
            if (!instance->syncDb->isOpen())
            {
                isolate->ThrowException(v8::Exception::Error(
                    V8Helpers::ToV8String(isolate, instance->syncDb->lastError())));
                return;
            }

            auto ext = v8::External::New(isolate, instance.release());
            args.This()->SetInternalField(0, ext);
        }

        static void Close(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            // Resolve as a promise
            auto resolver = V8Helpers::NewResolver(args.GetIsolate());
            args.GetReturnValue().Set(resolver->GetPromise());
            auto *persistentResolver = new v8::Persistent<v8::Promise::Resolver>(args.GetIsolate(), resolver);

            // Sync connection is JS-thread-only; close it immediately.
            if (instance->syncDb)
                instance->syncDb->close();

            // Countdown latch — resolve the Promise once every connection has been closed.
            int total = 1 + static_cast<int>(instance->readerDispatchers.size());
            auto latch = std::make_shared<std::atomic<int>>(total);
            auto tick = [instance, persistentResolver, latch]()
            {
                if (latch->fetch_sub(1, std::memory_order_acq_rel) == 1)
                {
                    instance->adapter->resolveVoid(persistentResolver);
                }
            };

            for (size_t i = 0; i < instance->readerDispatchers.size(); ++i)
            {
                SQLiteConnection *rdb = instance->readerDbs[i].get();
                instance->readerDispatchers[i]->dispatch([rdb]()
                                                         { rdb->close(); }, tick);
            }

            instance->writerDispatcher->dispatch(
                [instance]()
                { if (instance->writerDb) instance->writerDb->close(); },
                tick);
        }

        // Dispatch work to the given dispatcher; resolve or reject the Promise on the
        // JS thread via ALooper.
        // F1: () -> QueryResult      (runs on worker thread — MUST NOT touch V8)
        // F2: (DBInstance*, void*, const QueryResult&) -> void  (runs on JS thread)
        template <typename F1, typename F2>
        static void Dispatch(AndroidDispatcher &dispatcher, DBInstance *instance,
                             v8::Isolate *isolate, v8::Local<v8::Promise::Resolver> resolver,
                             F1 work, F2 completion)
        {
            auto *persistentResolver = new v8::Persistent<v8::Promise::Resolver>(isolate, resolver);
            auto resultPtr = std::make_shared<QueryResult>();

            dispatcher.dispatch(
                [work = std::move(work), resultPtr]() mutable
                {
                    *resultPtr = work();
                },
                [instance, persistentResolver, completion = std::move(completion), resultPtr]()
                {
                    if (resultPtr->success)
                    {
                        completion(instance, persistentResolver, *resultPtr);
                    }
                    else
                    {
                        instance->adapter->reject(persistentResolver, resultPtr->error, resultPtr->errorCode);
                    }
                });
        }

        // Round-robin reader selection.
        static std::pair<AndroidDispatcher *, SQLiteConnection *> NextReader(DBInstance *instance)
        {
            int n = static_cast<int>(instance->readerDispatchers.size());
            int idx = instance->readerIndex.fetch_add(1, std::memory_order_relaxed) % n;
            return {instance->readerDispatchers[idx].get(), instance->readerDbs[idx].get()};
        }

        static void AsyncExecute(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, sql, params = std::move(params)]() -> QueryResult
                     { return wdb->execute(sql, params); }, [](DBInstance *inst, void *ctx, const QueryResult &)
                     { inst->adapter->resolveVoid(ctx); });
        }

        static void AsyncSelect(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            auto reader = NextReader(instance);
            AndroidDispatcher *dispatcher = reader.first;
            SQLiteConnection *rdb = reader.second;
            Dispatch(*dispatcher, instance, isolate, resolver, [rdb, sql, params = std::move(params)]() -> QueryResult
                     { return rdb->executeJson(sql, params); }, [](DBInstance *inst, void *ctx, const QueryResult &res)
                     { inst->adapter->resolveWithRows(ctx, res); });
        }

        static void AsyncSelectArray(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            auto reader = NextReader(instance);
            AndroidDispatcher *dispatcher = reader.first;
            SQLiteConnection *rdb = reader.second;
            Dispatch(*dispatcher, instance, isolate, resolver, [rdb, sql, params = std::move(params)]() -> QueryResult
                     { return rdb->executeArrayJson(sql, params); }, [](DBInstance *inst, void *ctx, const QueryResult &res)
                     { inst->adapter->resolveWithArrayResult(ctx, res); });
        }

        static void AsyncGet(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            auto reader = NextReader(instance);
            AndroidDispatcher *dispatcher = reader.first;
            SQLiteConnection *rdb = reader.second;
            Dispatch(*dispatcher, instance, isolate, resolver, [rdb, sql, params = std::move(params)]() -> QueryResult
                     { return rdb->executeGetJson(sql, params); }, [](DBInstance *inst, void *ctx, const QueryResult &res)
                     { inst->adapter->resolveWithFirstRow(ctx, res); });
        }

        static void AsyncGetArray(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            auto reader = NextReader(instance);
            AndroidDispatcher *dispatcher = reader.first;
            SQLiteConnection *rdb = reader.second;
            Dispatch(*dispatcher, instance, isolate, resolver, [rdb, sql, params = std::move(params)]() -> QueryResult
                     { return rdb->executeGetArrayJson(sql, params); }, [](DBInstance *inst, void *ctx, const QueryResult &res)
                     { inst->adapter->resolveWithFirstArrayRow(ctx, res); });
        }

        //  Sync Methods

        static void SyncExecute(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            QueryResult res = instance->syncDb->execute(sql, params);
            if (!res.success)
            {
                isolate->ThrowException(v8::Exception::Error(V8Helpers::ToV8String(isolate, res.error)));
                return;
            }

            instance->adapter->returnVoid((void *)&args);
        }

        static void SyncSelect(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            QueryResult res = instance->syncDb->execute(sql, params);
            if (!res.success)
            {
                isolate->ThrowException(v8::Exception::Error(V8Helpers::ToV8String(isolate, res.error)));
                return;
            }

            instance->adapter->returnRows((void *)&args, res);
        }

        static void SyncSelectArray(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            QueryResult res = instance->syncDb->execute(sql, params);
            if (!res.success)
            {
                isolate->ThrowException(v8::Exception::Error(V8Helpers::ToV8String(isolate, res.error)));
                return;
            }

            instance->adapter->returnArrayResult((void *)&args, res);
        }

        static void SyncGet(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            QueryResult res = instance->syncDb->executeGet(sql, params);
            if (!res.success)
            {
                isolate->ThrowException(v8::Exception::Error(V8Helpers::ToV8String(isolate, res.error)));
                return;
            }

            instance->adapter->returnFirstRow((void *)&args, res);
        }

        static void SyncGetArray(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            std::string sql = V8Helpers::FromV8String(isolate, args[0]);
            ParamList params = ParseParams(isolate, args[1]);

            QueryResult res = instance->syncDb->executeGet(sql, params);
            if (!res.success)
            {
                isolate->ThrowException(v8::Exception::Error(V8Helpers::ToV8String(isolate, res.error)));
                return;
            }

            instance->adapter->returnFirstArrayRow((void *)&args, res);
        }

        //  Prepared Statements

        static void Prepare(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            std::string sql = V8Helpers::FromV8String(isolate, args[0]);

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, sql]() -> QueryResult
                     {
            uint32_t stmtId = wdb->prepareStatement(sql);
            QueryResult res;
            if (stmtId > 0) {
                res.success  = true;
                res.insertId = stmtId;
            } else {
                res.success   = false;
                res.error     = wdb->lastError();
                res.errorCode = wdb->lastCode();
            }
            return res; }, [](DBInstance *inst, void *ctx, const QueryResult &res)
                     { inst->adapter->resolveWithId(ctx, static_cast<uint32_t>(res.insertId)); });
        }

        static void StepStatement(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            uint32_t stmtId = args[0]->Uint32Value(isolate->GetCurrentContext()).ToChecked();
            ParamList params = ParseParams(isolate, args[1]);

            // We need a mode argument: 0=execute, 1=select, 2=selectArray, 3=get, 4=getArray
            int mode = args.Length() > 2 ? args[2]->Int32Value(isolate->GetCurrentContext()).ToChecked() : 0;

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, stmtId, params = std::move(params), mode]() -> QueryResult
                     {
            if (mode == 1) return wdb->stepStatementJson(stmtId, params, false);
            if (mode == 2) return wdb->stepStatementArrayJson(stmtId, params, false);
            if (mode == 3) return wdb->stepStatementJson(stmtId, params, true);
            if (mode == 4) return wdb->stepStatementArrayJson(stmtId, params, true);
            return wdb->stepStatement(stmtId, params); }, [mode](DBInstance *inst, void *ctx, const QueryResult &res)
                     {
            if (mode == 0) inst->adapter->resolveVoid(ctx);
            else if (mode == 1) inst->adapter->resolveWithRows(ctx, res);
            else if (mode == 2) inst->adapter->resolveWithArrayResult(ctx, res);
            else if (mode == 3) inst->adapter->resolveWithFirstRow(ctx, res);
            else if (mode == 4) inst->adapter->resolveWithFirstArrayRow(ctx, res); });
        }

        static void FinalizeStatement(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            uint32_t stmtId = args[0]->Uint32Value(isolate->GetCurrentContext()).ToChecked();

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, stmtId]() -> QueryResult
                     {
            wdb->finalizeStatement(stmtId);
            QueryResult res;
            res.success = true;
            return res; }, [](DBInstance *inst, void *ctx, const QueryResult &)
                     { inst->adapter->resolveVoid(ctx); });
        }

        //  Transactions

        static void BeginTransaction(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            TxBehavior behavior = TxBehavior::Deferred;
            if (args.Length() > 0 && args[0]->IsString())
            {
                std::string b = V8Helpers::FromV8String(isolate, args[0]);
                if (b == "immediate")
                    behavior = TxBehavior::Immediate;
                else if (b == "exclusive")
                    behavior = TxBehavior::Exclusive;
            }

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, behavior]() -> QueryResult
                     {
            uint32_t txId = wdb->beginTransaction(behavior);
            QueryResult res;
            if (txId > 0) {
                res.success  = true;
                res.insertId = txId;
            } else {
                res.success   = false;
                res.error     = wdb->lastError();
                res.errorCode = wdb->lastCode();
            }
            return res; }, [](DBInstance *inst, void *ctx, const QueryResult &res)
                     { inst->adapter->resolveWithId(ctx, static_cast<uint32_t>(res.insertId)); });
        }

        static void CommitTransaction(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            uint32_t txId = args[0]->Uint32Value(isolate->GetCurrentContext()).ToChecked();

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, txId]() -> QueryResult
                     {
            wdb->commitTransaction(txId);
            QueryResult res;
            res.success = true;
            return res; }, [](DBInstance *inst, void *ctx, const QueryResult &)
                     { inst->adapter->resolveVoid(ctx); });
        }

        static void RollbackTransaction(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            uint32_t txId = args[0]->Uint32Value(isolate->GetCurrentContext()).ToChecked();

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, txId]() -> QueryResult
                     {
            wdb->rollbackTransaction(txId);
            QueryResult res;
            res.success = true;
            return res; }, [](DBInstance *inst, void *ctx, const QueryResult &)
                     { inst->adapter->resolveVoid(ctx); });
        }

        static void ExecuteInTransaction(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            uint32_t txId = args[0]->Uint32Value(isolate->GetCurrentContext()).ToChecked();
            std::string sql = V8Helpers::FromV8String(isolate, args[1]);
            ParamList params = ParseParams(isolate, args[2]);

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, txId, sql, params = std::move(params)]() -> QueryResult
                     { return wdb->executeInTransaction(txId, sql, params); }, [](DBInstance *inst, void *ctx, const QueryResult &)
                     { inst->adapter->resolveVoid(ctx); });
        }

        static void SelectInTransaction(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto resolver = V8Helpers::NewResolver(isolate);
            args.GetReturnValue().Set(resolver->GetPromise());

            uint32_t txId = args[0]->Uint32Value(isolate->GetCurrentContext()).ToChecked();
            std::string sql = V8Helpers::FromV8String(isolate, args[1]);
            ParamList params = ParseParams(isolate, args[2]);

            // Mode: 1=select, 2=selectArray
            int mode = args.Length() > 3 ? args[3]->Int32Value(isolate->GetCurrentContext()).ToChecked() : 1;

            SQLiteConnection *wdb = instance->writerDb.get();
            Dispatch(*instance->writerDispatcher, instance, isolate, resolver, [wdb, txId, sql, params = std::move(params), mode]() -> QueryResult
                     {
            if (mode == 2) return wdb->selectInTransactionArrayJson(txId, sql, params);
            return wdb->selectInTransactionJson(txId, sql, params); }, [mode](DBInstance *inst, void *ctx, const QueryResult &res)
                     {
            if (mode == 2) inst->adapter->resolveWithArrayResult(ctx, res);
            else           inst->adapter->resolveWithRows(ctx, res); });
        }

        static void GetRuntimeInfo(const v8::FunctionCallbackInfo<v8::Value> &args)
        {
            auto *instance = GetInstance(args);
            if (!instance)
                return;

            auto isolate = args.GetIsolate();
            auto ctx = isolate->GetCurrentContext();
            auto info = instance->writerDb->getRuntimeInfo();

            auto obj = v8::Object::New(isolate);
            V8Helpers::SetProp(isolate, ctx, obj, "version", V8Helpers::ToV8String(isolate, info.version));
            V8Helpers::SetProp(isolate, ctx, obj, "sourceId", V8Helpers::ToV8String(isolate, info.sourceId));

            auto arr = v8::Array::New(isolate, static_cast<int>(info.compileOptions.size()));
            for (size_t i = 0; i < info.compileOptions.size(); ++i)
            {
                arr->Set(ctx, static_cast<uint32_t>(i),
                         V8Helpers::ToV8String(isolate, info.compileOptions[i]))
                    .Check();
            }
            V8Helpers::SetProp(isolate, ctx, obj, "compileOptions", arr);

            args.GetReturnValue().Set(obj);
        }

        //  Initialization

        void Init(v8::Isolate *isolate)
        {
            v8::HandleScope handle_scope(isolate);
            auto ctx = isolate->GetCurrentContext();
            auto global = ctx->Global();

            // Create the constructor template
            auto ctorTmpl = v8::FunctionTemplate::New(isolate, Open);
            ctorTmpl->InstanceTemplate()->SetInternalFieldCount(1);
            ctorTmpl->SetClassName(V8Helpers::ToV8String(isolate, "NSCSQLite"));

            auto proto = ctorTmpl->PrototypeTemplate();

            proto->Set(isolate, "close", v8::FunctionTemplate::New(isolate, Close));
            proto->Set(isolate, "execute", v8::FunctionTemplate::New(isolate, AsyncExecute));
            proto->Set(isolate, "select", v8::FunctionTemplate::New(isolate, AsyncSelect));
            proto->Set(isolate, "selectArray", v8::FunctionTemplate::New(isolate, AsyncSelectArray));
            proto->Set(isolate, "get", v8::FunctionTemplate::New(isolate, AsyncGet));
            proto->Set(isolate, "getArray", v8::FunctionTemplate::New(isolate, AsyncGetArray));

            proto->Set(isolate, "executeSync", v8::FunctionTemplate::New(isolate, SyncExecute));
            proto->Set(isolate, "selectSync", v8::FunctionTemplate::New(isolate, SyncSelect));
            proto->Set(isolate, "selectArraySync", v8::FunctionTemplate::New(isolate, SyncSelectArray));
            proto->Set(isolate, "getSync", v8::FunctionTemplate::New(isolate, SyncGet));
            proto->Set(isolate, "getArraySync", v8::FunctionTemplate::New(isolate, SyncGetArray));

            proto->Set(isolate, "prepare", v8::FunctionTemplate::New(isolate, Prepare));
            proto->Set(isolate, "stepStatement", v8::FunctionTemplate::New(isolate, StepStatement));
            proto->Set(isolate, "finalizeStatement", v8::FunctionTemplate::New(isolate, FinalizeStatement));

            proto->Set(isolate, "beginTransaction", v8::FunctionTemplate::New(isolate, BeginTransaction));
            proto->Set(isolate, "commitTransaction", v8::FunctionTemplate::New(isolate, CommitTransaction));
            proto->Set(isolate, "rollbackTransaction", v8::FunctionTemplate::New(isolate, RollbackTransaction));
            proto->Set(isolate, "executeInTransaction", v8::FunctionTemplate::New(isolate, ExecuteInTransaction));
            proto->Set(isolate, "selectInTransaction", v8::FunctionTemplate::New(isolate, SelectInTransaction));

            proto->Set(isolate, "getRuntimeInfo", v8::FunctionTemplate::New(isolate, GetRuntimeInfo));

            auto ctor = ctorTmpl->GetFunction(ctx).ToLocalChecked();
            global->Set(ctx, V8Helpers::ToV8String(isolate, "NSCSQLite"), ctor).Check();
        }

    } // namespace DatabaseBinding
} // namespace NSCSQLite
