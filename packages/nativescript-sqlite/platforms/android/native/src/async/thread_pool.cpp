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
    {
        std::lock_guard<std::mutex> lk(mutex_);
        stop_.store(true, std::memory_order_release);
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
                    if (!tasks_.empty()) {
                        task = std::move(tasks_.front());
                        tasks_.pop();
                        break;
                    }
                }
            }
            // Yield after half the spins to reduce CPU pressure when idle.
            if (spin > kSpinCount / 2) std::this_thread::yield();
        }

        if (task) {
            task(); // MUST NOT touch V8
            continue;
        }

        // ── Slow path: sleep until work arrives ───────────────────────────
        {
            std::unique_lock<std::mutex> lk(mutex_);
            cv_.wait(lk, [this] {
                return stop_.load(std::memory_order_acquire) || !tasks_.empty();
            });
            if (stop_.load(std::memory_order_acquire) && tasks_.empty()) return;
            task = std::move(tasks_.front());
            tasks_.pop();
        }
        task(); // MUST NOT touch V8
    }
}

} // namespace NSCSQLite
