package com.playerpanel.fabric.security;

import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class RateLimiter {
    private static final long WINDOW_MS = 60_000L;
    private final boolean enabled;
    private final int limit;
    private final ConcurrentMap<String, Window> windows = new ConcurrentHashMap<>();

    public RateLimiter(boolean enabled, int limit) {
        this.enabled = enabled;
        this.limit = Math.max(1, limit);
    }

    public boolean allow(String key) {
        if (!enabled) return true;
        long now = System.currentTimeMillis();
        Window w = windows.compute(key == null ? "unknown" : key, (k, old) -> {
            if (old == null || now - old.startedAt > WINDOW_MS) return new Window(now);
            return old;
        });
        return w.count.incrementAndGet() <= limit;
    }

    private static final class Window {
        final long startedAt;
        final AtomicInteger count = new AtomicInteger();
        Window(long startedAt) { this.startedAt = startedAt; }
    }
}
