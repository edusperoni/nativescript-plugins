#include "android_dispatcher.h"
#include "../common/log.h"

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

void AndroidDispatcher::drainCompletions()
{
    // We are on the JS thread, called from the ALooper between JS tasks.
    // The thread-pool workers hold no V8 lock at this point, so acquiring
    // v8::Locker here is uncontested (instant) — unlike the old approach
    // where workers held the Locker while the JS thread was executing.
    v8::Locker            locker(isolate_);
    v8::Isolate::Scope    isolate_scope(isolate_);
    v8::HandleScope       handle_scope(isolate_);
    auto ctx = context_.Get(isolate_);
    v8::Context::Scope    ctx_scope(ctx);

    std::vector<std::function<void()>> drained;
    {
        std::lock_guard<std::mutex> lk(completionMtx_);
        std::swap(drained, pending_);
    }
    for (auto& fn : drained) {
        fn(); // resolveWithRows / resolveVoid / reject / etc.
    }
}

void AndroidDispatcher::dispatch(std::function<void()> work,
                                 std::function<void()> completion)
{
    pool_.enqueue([this,
                   work       = std::move(work),
                   completion = std::move(completion)]() mutable
    {
        // Execute pure SQLite work — MUST NOT touch V8.
        work();

        // Enqueue the completion for the JS thread.
        {
            std::lock_guard<std::mutex> lk(completionMtx_);
            pending_.push_back(std::move(completion));
        }

        // Signal the ALooper on the JS thread.  Multiple concurrent signals
        // accumulate in the eventfd counter; a single drain pass handles them all.
        uint64_t val = 1;
        ::write(eventFd_, &val, sizeof(val));
    });
}

} // namespace NSCSQLite
