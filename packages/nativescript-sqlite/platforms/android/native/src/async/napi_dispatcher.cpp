#include "napi_dispatcher.h"
#include "../common/log.h"

#include <chrono>

namespace NSCSQLite {

// A statement chained from a completion is answered by its worker about a
// microsecond later, while handing control back to the looper costs a thread
// wake-up (~10 µs on an emulator, 50-200 µs on a device) — which dominates an
// awaited statement loop.  Spin for this long after a completion whose
// continuation dispatched more work before giving the looper the thread back.
static constexpr auto kChainSpin = std::chrono::microseconds(40);

// Hard ceiling on one drain, so an arbitrarily long awaited chain can never
// starve the UI looper: past it the drain returns and the next completion
// signals the threadsafe function normally.
static constexpr auto kMaxDrain = std::chrono::milliseconds(4);

bool NapiCompletionQueue::init(napi_env env)
{
    napi_value name = nullptr;
    if (napi_create_string_utf8(env, "nscsqlite.completions", NAPI_AUTO_LENGTH, &name) != napi_ok) {
        LogError("[NapiDispatcher] failed to create the threadsafe function name");
        return false;
    }

    // Unbounded queue: a worker must never block waiting for the JS thread, and
    // the batching below keeps this to about one queued call per drain anyway.
    napi_status status = napi_create_threadsafe_function(
        env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, this, CallJs, &tsfn_);
    if (status != napi_ok) {
        LogError("[NapiDispatcher] napi_create_threadsafe_function failed");
        tsfn_ = nullptr;
        return false;
    }
    return true;
}

void NapiCompletionQueue::shutdown()
{
    napi_threadsafe_function tsfn = nullptr;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        tsfn = tsfn_;
        tsfn_ = nullptr;
        pending_.clear();
        pendingCount_.store(0, std::memory_order_release);
        signalPending_ = false;
    }
    // Aborting destroys the function, so no later call_js can reach this object.
    if (tsfn) {
        napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    }
}

void NapiCompletionQueue::post(std::function<void()> completion)
{
    // The threadsafe function is called under the same lock that guards the
    // queue so a concurrent shutdown() cannot destroy it mid-call.
    std::lock_guard<std::mutex> lk(mtx_);
    pending_.push_back(std::move(completion));
    pendingCount_.store(pending_.size(), std::memory_order_release);
    if (signalPending_ || tsfn_ == nullptr) return;

    // One signal covers every completion queued until a drain observes an empty
    // queue and clears the flag under this same lock.  A completion pushed while
    // a drain is running therefore needs no signal of its own — that drain, or
    // its spin phase, is guaranteed to come back for it.
    if (napi_call_threadsafe_function(tsfn_, nullptr, napi_tsfn_nonblocking) == napi_ok) {
        signalPending_ = true;
    }
}

// static
void NapiCompletionQueue::CallJs(napi_env env, napi_value /*jsCallback*/, void* context, void* /*data*/)
{
    auto* self = static_cast<NapiCompletionQueue*>(context);
    if (env == nullptr) {
        // The env is gone; completions must not touch JS any more.
        std::lock_guard<std::mutex> lk(self->mtx_);
        self->pending_.clear();
        self->pendingCount_.store(0, std::memory_order_release);
        self->signalPending_ = false;
        return;
    }
    self->drain(env);
}

bool NapiCompletionQueue::takeBatch(std::vector<std::function<void()>>& batch)
{
    std::lock_guard<std::mutex> lk(mtx_);
    if (pending_.empty()) return false;
    batch.swap(pending_);
    pendingCount_.store(0, std::memory_order_release);
    return true;
}

// Clears the signal only while the queue is observably empty, so a completion
// posted a moment earlier can never be left with no drain coming for it.
bool NapiCompletionQueue::finish()
{
    std::lock_guard<std::mutex> lk(mtx_);
    if (!pending_.empty()) return false;
    signalPending_ = false;
    return true;
}

// Leaves the drain with work still queued: the signal this drain consumed has
// to be replaced, or the queued completions would wait for a producer that
// (seeing the flag set) will never signal again.
void NapiCompletionQueue::requeue()
{
    std::lock_guard<std::mutex> lk(mtx_);
    signalPending_ = false;
    if (pending_.empty() || tsfn_ == nullptr) return;
    if (napi_call_threadsafe_function(tsfn_, nullptr, napi_tsfn_nonblocking) == napi_ok) {
        signalPending_ = true;
    }
}

void NapiCompletionQueue::drain(napi_env env)
{
    const auto hardDeadline = std::chrono::steady_clock::now() + kMaxDrain;
    draining_ = true;
    dispatchedWhileDraining_ = false;

    std::vector<std::function<void()>> batch;
    for (;;) {
        auto now = std::chrono::steady_clock::now();
        if (now >= hardDeadline) {
            requeue();
            break;
        }

        if (takeBatch(batch)) {
            dispatchedWhileDraining_ = false;

            napi_handle_scope scope = nullptr;
            if (napi_open_handle_scope(env, &scope) != napi_ok) {
                requeue();
                break;
            }
            for (auto& fn : batch) {
                fn(); // resolveWithRows / resolveVoid / reject / teardown tick
            }
            napi_close_handle_scope(env, scope);
            batch.clear();
            continue;
        }

        if (!dispatchedWhileDraining_) {
            if (finish()) break;
            continue;
        }

        // A continuation dispatched more work: wait for its answer here rather
        // than handing the thread back to the looper for a few microseconds.
        auto spinDeadline = now + kChainSpin;
        if (spinDeadline > hardDeadline) spinDeadline = hardDeadline;
        int spins = 0;
        while (pendingCount_.load(std::memory_order_acquire) == 0) {
            if ((++spins & 0x3f) == 0 && std::chrono::steady_clock::now() >= spinDeadline) break;
        }
        if (pendingCount_.load(std::memory_order_acquire) == 0 && finish()) break;
    }

    draining_ = false;
}

NapiDispatcher::NapiDispatcher(NapiCompletionQueue& completions, unsigned int nThreads)
    : completions_(completions), pool_(nThreads)
{
}

void NapiDispatcher::dispatch(std::function<void()> work,
                              std::function<void()> completion)
{
    completions_.noteDispatch();
    pool_.enqueue([this,
                   work       = std::move(work),
                   completion = std::move(completion)]() mutable
    {
        // Execute pure SQLite work — MUST NOT touch Node-API.
        work();
        completions_.post(std::move(completion));
    });
}

} // namespace NSCSQLite
