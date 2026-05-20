#pragma once

// ---------------------------------------------------------------------------
// ThreadPool — Layer 2: Worker thread management.
// NO V8, NO JNI.  Tasks submitted here MUST NOT touch V8.
// ---------------------------------------------------------------------------

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>

namespace NSCSQLite {

class ThreadPool {
public:
    /// nThreads == 0 → use hardware_concurrency() (min 1)
    explicit ThreadPool(unsigned int nThreads = 0);
    ~ThreadPool();

    ThreadPool(const ThreadPool&)            = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    /// Submit a task to the pool.  Thread-safe.
    void enqueue(std::function<void()> task);

    unsigned int threadCount() const { return static_cast<unsigned int>(workers_.size()); }

private:
    void workerThread();

    std::vector<std::thread>          workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex                        mutex_;
    std::condition_variable           cv_;
    std::atomic<bool>                 stop_{false};
};

} // namespace NSCSQLite
