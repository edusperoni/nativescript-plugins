#include "android_dispatcher.h"
#include "../common/log.h"

#include <algorithm>
#include <chrono>
#include <iterator>
#include <sys/eventfd.h>
#include <unistd.h>
#include <android/log.h>

namespace NSCSQLite {

AndroidDispatcher::AndroidDispatcher(unsigned int nThreads)
    : pool_(nThreads)
{
}

AndroidDispatcher::~AndroidDispatcher()
{
    // Before the fd is closed: a worker signals eventFd_ after its task, and
    // pool_ (a member, so destroyed only after this body) would otherwise still
    // be running one — writing to a descriptor number the process has since
    // handed to something else.
    pool_.shutdown();

    if (looper_ && eventFd_ >= 0) {
        ALooper_removeFd(looper_, eventFd_);
    }
    if (eventFd_ >= 0) {
        ::close(eventFd_);
        eventFd_ = -1;
    }
    context_.Reset();
}

void AndroidDispatcher::attachToRuntimeThread(v8::Isolate* isolate)
{
    isolate_ = isolate;
    // Capture the current context while we're on the JS thread.
    context_.Reset(isolate, isolate->GetCurrentContext());

    // Create a non-blocking eventfd used to wake the JS thread's ALooper.
    eventFd_ = ::eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (eventFd_ < 0) {
        LogError("[AndroidDispatcher] eventfd() failed");
        return;
    }

    // Register with the calling thread's ALooper (must be the JS thread).
    looper_ = ALooper_forThread();
    if (!looper_) {
        LogError("[AndroidDispatcher] No ALooper found for JS thread");
        return;
    }

    int rc = ALooper_addFd(looper_, eventFd_,
                           ALOOPER_POLL_CALLBACK,
                           ALOOPER_EVENT_INPUT,
                           looperCallback,
                           this);
    if (rc < 0) {
        LogError("[AndroidDispatcher] ALooper_addFd() failed");
    }
}

// static
int AndroidDispatcher::looperCallback(int fd, int /*events*/, void* data)
{
    // Drain the eventfd counter (accumulated writes since last read).
    uint64_t count = 0;
    ::read(fd, &count, sizeof(count));

    auto* self = static_cast<AndroidDispatcher*>(data);
    self->drainCompletions();
    return 1; // keep callback registered
}

namespace {

// Set while a drain is running on this thread. dispatch() records the queues it
// feeds, which is how the drain learns that a completion's continuation issued
// the next statement — possibly on another dispatcher (reads rotate over the
// reader pool) or another database.
struct DrainContext {
    std::vector<std::shared_ptr<void>> fed;
};
thread_local DrainContext* tlsDrain = nullptr;

} // namespace

void AndroidDispatcher::drainCompletions()
{
    // We are on the JS thread, called from the ALooper between JS tasks.
    // The thread-pool workers hold no V8 lock at this point, so acquiring
    // v8::Locker here is uncontested (instant) — unlike the old approach
    // where workers held the Locker while the JS thread was executing.
    v8::Isolate* isolate = isolate_;
    v8::Locker            locker(isolate);
    v8::Isolate::Scope    isolate_scope(isolate);
    v8::HandleScope       handle_scope(isolate);
    auto ctx = context_.Get(isolate);
    v8::Context::Scope    ctx_scope(ctx);

    // A completion may delete this dispatcher, so nothing below may touch
    // members once the first completion has run.
    std::vector<std::shared_ptr<CompletionQueue>> polled{queue_};

    // When a completion's continuation dispatches the next statement right away
    // (an awaited loop), the spinning worker answers within a few microseconds.
    // Returning to the looper in between would block this thread in epoll_wait
    // and cost a full thread wake-up per statement, so keep polling for as long
    // as the chain continues: kChainWait after the last completion, and never
    // more than kMaxDrain per looper callback so the UI thread is not starved.
    using Clock = std::chrono::steady_clock;
    static constexpr auto kChainWait = std::chrono::microseconds(40);
    static constexpr auto kMaxDrain  = std::chrono::milliseconds(4);

    // A completion that pumps the looper re-enters here; the outer drain keeps
    // ownership of the chain.
    const bool outermost = tlsDrain == nullptr;
    DrainContext context;
    if (outermost) tlsDrain = &context;

    const auto drainDeadline = Clock::now() + kMaxDrain;
    auto chainDeadline = Clock::time_point::min();

    std::vector<std::function<void()>> batch;
    for (;;) {
        for (auto& queue : polled) {
            std::lock_guard<std::mutex> lk(queue->mtx);
            if (batch.empty()) {
                std::swap(batch, queue->pending);
            } else {
                std::move(queue->pending.begin(), queue->pending.end(), std::back_inserter(batch));
                queue->pending.clear();
            }
        }
        if (batch.empty()) {
            if (Clock::now() >= chainDeadline) break;
            continue;
        }

        context.fed.clear();
        {
            // Per batch: a long chain must not accumulate handles in the outer scope.
            v8::HandleScope batch_scope(isolate);
            for (auto& fn : batch) {
                fn(); // resolveWithRows / resolveVoid / reject / etc.
            }
        }
        batch.clear();

        const auto now = Clock::now();
        if (!outermost || context.fed.empty() || now >= drainDeadline) break;

        polled.clear();
        for (auto& fed : context.fed) {
            polled.push_back(std::static_pointer_cast<CompletionQueue>(fed));
        }
        chainDeadline = std::min(now + kChainWait, drainDeadline);
    }

    if (outermost) tlsDrain = nullptr;
}

void AndroidDispatcher::dispatch(std::function<void()> work,
                                 std::function<void()> completion)
{
    if (tlsDrain) {
        auto& fed = tlsDrain->fed;
        if (std::find(fed.begin(), fed.end(), queue_) == fed.end()) fed.push_back(queue_);
    }

    pool_.enqueue([this,
                   queue      = queue_,
                   work       = std::move(work),
                   completion = std::move(completion)]() mutable
    {
        // Execute pure SQLite work — MUST NOT touch V8.
        work();

        // Enqueue the completion for the JS thread.
        {
            std::lock_guard<std::mutex> lk(queue->mtx);
            queue->pending.push_back(std::move(completion));
        }

        // Signal the ALooper on the JS thread.  Multiple concurrent signals
        // accumulate in the eventfd counter; a single drain pass handles them all.
        uint64_t val = 1;
        ::write(eventFd_, &val, sizeof(val));
    });
}

} // namespace NSCSQLite
