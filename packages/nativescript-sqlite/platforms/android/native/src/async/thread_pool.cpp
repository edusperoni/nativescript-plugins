#include "thread_pool.h"
#include <algorithm>

namespace NSCSQLite {

// Number of spin iterations before the worker sleeps.
// At ~1 ns/iteration on ARM64 this is roughly 2 µs of busy-wait —
// enough to catch back-to-back tasks (e.g. transaction rows) without
// ever paying the futex wake latency (~50-200 µs on Android).
static constexpr int kSpinCount = 2000;

ThreadPool::ThreadPool(unsigned int nThreads) {
    if (nThreads == 0) {
        nThreads = std::max(1u, std::thread::hardware_concurrency());
    }
    workers_.reserve(nThreads);
    for (unsigned int i = 0; i < nThreads; ++i) {
        workers_.emplace_back([this] { workerThread(); });
    }
}

ThreadPool::~ThreadPool() {
    shutdown();
}

void ThreadPool::shutdown() {
    {
        std::lock_guard<std::mutex> lk(mutex_);
        stop_.store(true, std::memory_order_release);
        // An inline claim outlives its owner only if that owner leaked it, and
        // only the thread running this can hold one; leaving it set would wedge
        // the join below forever. A claim held by a worker is left alone — that
        // worker clears it itself, and clearing it here would let a second
        // worker start a task beside it.
        if (inlineDepth_ > 0) {
            busy_        = false;
            inlineDepth_ = 0;
            inlineOwner_ = std::thread::id();
        }
    }
    cv_.notify_all();
    for (auto& t : workers_) {
        if (t.joinable()) t.join();
    }
}

void ThreadPool::enqueue(std::function<void()> task) {
    {
        std::lock_guard<std::mutex> lk(mutex_);
        tasks_.push(std::move(task));
    }
    cv_.notify_one();
}

void ThreadPool::acquireInline() {
    std::unique_lock<std::mutex> lk(mutex_);
    const std::thread::id self = std::this_thread::get_id();

    if (inlineDepth_ > 0 && inlineOwner_ == self) {
        ++inlineDepth_;
        return;
    }

    // Fast path: nothing queued and nothing running, so claiming the pool here
    // costs one uncontended lock/unlock pair and no thread hand-off.
    if (tasks_.empty() && !busy_) {
        busy_        = true;
        inlineOwner_ = self;
        inlineDepth_ = 1;
        return;
    }

    // Queued work has to run first.  The wrapper hands the worker's claim to
    // this thread instead of releasing it, so the span that follows excludes
    // everything still queued behind it.
    bool granted = false;
    std::condition_variable handed;
    tasks_.push([this, self, &granted, &handed] {
        std::lock_guard<std::mutex> lk(mutex_);
        inlineOwner_    = self;
        inlineDepth_    = 1;
        claimHandedOff_ = true;
        granted         = true;
        // Signalled under mutex_: the waiter must not be able to return and
        // destroy `handed` between the store and the notify.
        handed.notify_one();
    });
    cv_.notify_one();
    handed.wait(lk, [&granted] { return granted; });
}

void ThreadPool::releaseInline() {
    std::lock_guard<std::mutex> lk(mutex_);
    if (inlineDepth_ == 0) return;
    if (--inlineDepth_ > 0) return;
    inlineOwner_ = std::thread::id();
    busy_        = false;
    // Nothing queued means no worker can make progress, and the synchronous
    // path would otherwise pay a futex wake per statement.
    if (!tasks_.empty()) cv_.notify_one();
}

void ThreadPool::runInline(FnRef fn) {
    struct Claim {
        ThreadPool* pool;
        ~Claim() { pool->releaseInline(); }
    };

    acquireInline();
    Claim claim{this};
    fn();
}

void ThreadPool::workerThread() {
    while (true) {
        std::function<void()> task;

        // ── Fast path: spin-wait ──────────────────────────────────────────
        // Avoids the futex wake cost for back-to-back enqueues (e.g. a
        // transaction loop where the JS thread immediately dispatches the
        // next row after each await resolution).
        for (int spin = 0; spin < kSpinCount; ++spin) {
            {
                std::unique_lock<std::mutex> lk(mutex_, std::try_to_lock);
                if (lk.owns_lock()) {
                    if (stop_.load(std::memory_order_acquire) && tasks_.empty()) return;
                    if (!busy_ && !tasks_.empty()) {
                        task = std::move(tasks_.front());
                        tasks_.pop();
                        busy_ = true;
                        break;
                    }
                }
            }
            // Yield after half the spins to reduce CPU pressure when idle.
            if (spin > kSpinCount / 2) std::this_thread::yield();
        }

        if (!task) {
            // ── Slow path: sleep until the pool is free and work is waiting ──
            std::unique_lock<std::mutex> lk(mutex_);
            cv_.wait(lk, [this] {
                if (busy_) return false;
                return !tasks_.empty() || stop_.load(std::memory_order_acquire);
            });
            if (tasks_.empty()) return; // stopping, nothing left to drain
            task = std::move(tasks_.front());
            tasks_.pop();
            busy_ = true;
        }

        task(); // MUST NOT touch V8

        bool wake, wakeAll;
        {
            std::lock_guard<std::mutex> lk(mutex_);
            // The task just run was an acquireInline wrapper: this worker's claim
            // now belongs to that caller, and only its releaseInline() may clear
            // it.  Only one task runs at a time, so the flag can only have been
            // set by the task this worker just ran.
            if (claimHandedOff_) claimHandedOff_ = false;
            else busy_ = false;
            // Workers that went back to sleep because this one held the pool are
            // the only ones left to end a shutdown, so they have to be woken for
            // it even with nothing left to run.
            wakeAll = stop_.load(std::memory_order_acquire);
            wake    = !busy_ && !tasks_.empty();
        }
        if (wakeAll) cv_.notify_all();
        else if (wake) cv_.notify_one();
    }
}

} // namespace NSCSQLite
