#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace NSCSQLite {

// ---------------------------------------------------------------------------
// HandleRegistry<T>
//
// Maps opaque uint32_t IDs to heap-allocated T instances.
// IDs are exposed to JS; raw pointers are never handed to the JS layer.
// Thread-safe — multiple worker threads may not add/remove concurrently but
// reads during dispatch are protected.
// ---------------------------------------------------------------------------

template <typename T>
class HandleRegistry {
public:
    HandleRegistry() = default;

    // Non-copyable, non-movable — registries are singletons per database
    HandleRegistry(const HandleRegistry&)            = delete;
    HandleRegistry& operator=(const HandleRegistry&) = delete;

    /// Store a new item and return its opaque ID.
    uint32_t add(std::unique_ptr<T> item) {
        uint32_t id = nextId_.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard<std::mutex> lk(mutex_);
        handles_.emplace(id, std::move(item));
        return id;
    }

    /// Borrow a raw (non-owning) pointer.  Returns nullptr if not found.
    T* get(uint32_t id) const {
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = handles_.find(id);
        return it != handles_.end() ? it->second.get() : nullptr;
    }

    /// Remove and return ownership.  Returns nullptr if not found.
    std::unique_ptr<T> remove(uint32_t id) {
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = handles_.find(id);
        if (it == handles_.end()) return nullptr;
        auto ptr = std::move(it->second);
        handles_.erase(it);
        return ptr;
    }

    /// True if the id is known.
    bool contains(uint32_t id) const {
        std::lock_guard<std::mutex> lk(mutex_);
        return handles_.count(id) > 0;
    }

    /// Destroy all remaining handles (e.g. on database close).
    void clear() {
        std::lock_guard<std::mutex> lk(mutex_);
        handles_.clear();
    }

    std::size_t size() const {
        std::lock_guard<std::mutex> lk(mutex_);
        return handles_.size();
    }

private:
    mutable std::mutex                             mutex_;
    std::atomic<uint32_t>                          nextId_{1};
    std::unordered_map<uint32_t, std::unique_ptr<T>> handles_;
};

} // namespace NSCSQLite
