#pragma once

// ---------------------------------------------------------------------------
// AndroidDispatcher — Layer 2: Async dispatch to thread pool.
//
// Architecture:
//   JS Thread   → dispatch(work, completion)
//   Worker      → executes work() [pure SQLite, NO V8]
//   Worker      → enqueues completion(), signals JS thread via eventfd
//   JS Thread   → ALooper fires, drains completions with proper V8 scopes
//
// RULE: work() MUST NOT touch V8.
//       completion() runs on the JS thread — v8::Locker acquired once in
//       drainCompletions() with zero contention (workers hold no lock here).
// ---------------------------------------------------------------------------

#include "thread_pool.h"
#include "v8.h"
#include <android/looper.h>
#include <functional>
#include <memory>
#include <mutex>
#include <vector>

namespace NSCSQLite {

class AndroidDispatcher {
public:
    /// nThreads == 0 → ThreadPool default (hardware_concurrency)
    explicit AndroidDispatcher(unsigned int nThreads = 0);
    ~AndroidDispatcher();

    AndroidDispatcher(const AndroidDispatcher&)            = delete;
    AndroidDispatcher& operator=(const AndroidDispatcher&) = delete;

    // Called from the JS thread after construction.
    // Captures the current V8 isolate + context and registers an ALooper
    // file-descriptor wakeup so worker completions are dispatched back to
    // the JS thread without any v8::Locker acquisition.
    void attachToRuntimeThread(v8::Isolate* isolate);

    // ── Submit work from the runtime thread ───────────────────────────────
    // work()       — runs on a worker thread, MUST NOT touch V8
    // completion() — posted back to JS thread via ALooper; no Locker needed
    void dispatch(std::function<void()> work,
                  std::function<void()> completion);

private:
    static int looperCallback(int fd, int events, void* data);
    void drainCompletions();

    v8::Isolate*              isolate_{nullptr};
    v8::Persistent<v8::Context> context_;

    int      eventFd_{-1};
    ALooper* looper_{nullptr};

    // Shared-ownership so a drain can keep polling a queue after a completion
    // has destroyed the dispatcher that owns it (close() deletes the DBInstance
    // from inside its last completion).
    struct CompletionQueue {
        std::mutex                         mtx;
        std::vector<std::function<void()>> pending;
    };
    std::shared_ptr<CompletionQueue> queue_{std::make_shared<CompletionQueue>()};

    ThreadPool pool_;
};

} // namespace NSCSQLite
