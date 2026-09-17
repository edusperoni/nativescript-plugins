#pragma once

// ---------------------------------------------------------------------------
// NapiDispatcher — Layer 2: Async dispatch to thread pool.
//
// Architecture:
//   JS Thread   → dispatch(work, completion)
//   Worker      → executes work() [pure SQLite, NO Node-API]
//   Worker      → queues completion() and signals the env's threadsafe function
//   JS Thread   → call_js drains the queue inside a handle scope
//
// RULE: work() MUST NOT make any Node-API call.
//       completion() runs on the thread that owns the env.
//
// Queries go through a threadsafe function rather than napi_create_async_work
// because each connection is pinned to one dispatcher thread: async work runs
// on a shared pool with no thread affinity, which would break both the SQLite
// single-thread connection contract and transaction ordering.
// ---------------------------------------------------------------------------

#include "thread_pool.h"
#include <node_api.h>
#include <atomic>
#include <functional>
#include <mutex>
#include <vector>

namespace NSCSQLite {

// One per env, shared by every dispatcher belonging to it.
class NapiCompletionQueue {
public:
    NapiCompletionQueue() = default;
    ~NapiCompletionQueue() = default;

    NapiCompletionQueue(const NapiCompletionQueue&)            = delete;
    NapiCompletionQueue& operator=(const NapiCompletionQueue&) = delete;

    // Called on the env's own thread.
    bool init(napi_env env);

    // Aborts the threadsafe function and drops anything still queued.
    // Called on the env's own thread, from the env cleanup hook.
    void shutdown();

    // Callable from any thread.
    void post(std::function<void()> completion);

    // Records that new work was submitted, so a drain in progress knows an
    // answer is about to arrive.  Env thread only.
    void noteDispatch() {
        if (draining_) dispatchedWhileDraining_ = true;
    }

private:
    static void CallJs(napi_env env, napi_value jsCallback, void* context, void* data);
    void drain(napi_env env);
    bool takeBatch(std::vector<std::function<void()>>& batch);
    bool finish();
    void requeue();

    napi_threadsafe_function tsfn_{nullptr};

    std::mutex                         mtx_;
    std::vector<std::function<void()>> pending_;
    bool                               signalPending_{false};
    // Read by the spin loop without taking the mutex.
    std::atomic<size_t>                pendingCount_{0};

    // Env thread only.
    bool draining_{false};
    bool dispatchedWhileDraining_{false};
};

class NapiDispatcher {
public:
    /// nThreads == 0 → ThreadPool default (hardware_concurrency)
    explicit NapiDispatcher(NapiCompletionQueue& completions, unsigned int nThreads = 0);
    ~NapiDispatcher() = default;

    NapiDispatcher(const NapiDispatcher&)            = delete;
    NapiDispatcher& operator=(const NapiDispatcher&) = delete;

    // ── Submit work from the env's thread ─────────────────────────────────
    // work()       — runs on a worker thread, MUST NOT touch Node-API
    // completion() — runs on the env's thread, inside a handle scope
    void dispatch(std::function<void()> work,
                  std::function<void()> completion);

private:
    NapiCompletionQueue& completions_;
    ThreadPool           pool_;
};

} // namespace NSCSQLite
