#pragma once

// ---------------------------------------------------------------------------
// ThreadPool — Layer 2: Worker thread management.
// NO V8, NO JNI.  Tasks submitted here MUST NOT touch V8.
//
// Exactly one task runs at a time, counting the inline work the JS thread runs
// through runInline() / acquireInline(): the pool is the serialization point
// for the one SQLite connection behind it, and the order tasks are submitted in
// is the order they run in.  A pool created with more than one worker still
// runs its tasks one at a time.
// ---------------------------------------------------------------------------

#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>
#include <type_traits>
#include <vector>

namespace NSCSQLite {

// Non-owning view of a callable, valid only for the duration of the call.
// runInline() is on the synchronous statement path, where building a
// std::function from a capturing lambda would cost a heap allocation.
class FnRef {
public:
    template <typename F,
              typename = std::enable_if_t<!std::is_same<std::decay_t<F>, FnRef>::value>>
    FnRef(F&& fn)
        : obj_(const_cast<void*>(static_cast<const void*>(std::addressof(fn)))),
          invoke_([](void* obj) { (*static_cast<std::remove_reference_t<F>*>(obj))(); }) {}

    void operator()() const { invoke_(obj_); }

private:
    void* obj_;
    void (*invoke_)(void*);
};

class ThreadPool {
public:
    /// nThreads == 0 → use hardware_concurrency() (min 1)
    explicit ThreadPool(unsigned int nThreads = 0);
    ~ThreadPool();

    ThreadPool(const ThreadPool&)            = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    /// Submit a task to the pool.  Thread-safe.
    void enqueue(std::function<void()> task);

    /// Drains the queue and joins every worker.  Idempotent, and called by the
    /// destructor.  An owner whose destructor body outlives this object's
    /// workers — one holding a file descriptor they still write to — must call
    /// it before tearing that state down.
    void shutdown();

    // ── Inline execution (the synchronous API) ────────────────────────────
    // Claims the pool for the calling thread, ordered behind everything already
    // queued: it runs straight through when the pool is idle, and otherwise
    // blocks until a worker reaches it and hands the claim over.
    //
    // acquireInline()/releaseInline() hold the claim across several calls (a
    // synchronous transaction), and nest: a runInline() issued by the thread
    // that already owns the pool runs straight through rather than claiming
    // again.  Every acquireInline() needs exactly one releaseInline(), or the
    // pool is wedged for every other caller.
    //
    // fn MUST NOT block on this pool by any other route: nothing it waits for
    // can run until it returns.
    void runInline(FnRef fn);
    void acquireInline();
    void releaseInline();

    unsigned int threadCount() const { return static_cast<unsigned int>(workers_.size()); }

private:
    void workerThread();

    std::vector<std::thread>          workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex                        mutex_;
    std::condition_variable           cv_;
    std::atomic<bool>                 stop_{false};

    // Guarded by mutex_.  busy_ is claimed before either a worker or an inline
    // caller runs anything, and is what makes the two mutually exclusive.
    // inlineDepth_ counts the nested acquires of an inline owner; claimHandedOff_
    // tells the worker that the task it just ran gave that owner its claim, so
    // it must leave busy_ set.
    bool             busy_{false};
    bool             claimHandedOff_{false};
    std::thread::id  inlineOwner_{};
    int              inlineDepth_{0};
};

} // namespace NSCSQLite
