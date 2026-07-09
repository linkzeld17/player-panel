package com.playerpanel.fabric.server;

import java.lang.management.ManagementFactory;
import java.util.*;

public final class MetricsTracker {
    private static final int TPS_HISTORY_SIZE = 200;
    private static final int MSPT_HISTORY_SIZE = 200;
    private final Object lock = new Object();
    private final long[] tickEnds = new long[TPS_HISTORY_SIZE];
    private final long[] durations = new long[MSPT_HISTORY_SIZE];
    private long startedNanos = System.nanoTime();
    private long startedAtEpochMillis = System.currentTimeMillis();
    private long tickStartedNanos;
    private long totalTicks;
    private int endIndex;
    private int endCount;
    private int durationIndex;
    private int durationCount;

    public void reset() {
        synchronized (lock) {
            Arrays.fill(tickEnds, 0L); Arrays.fill(durations, 0L);
            startedNanos = System.nanoTime(); startedAtEpochMillis = System.currentTimeMillis();
            tickStartedNanos = 0L; totalTicks = 0L; endIndex = endCount = durationIndex = durationCount = 0;
        }
    }

    public void onTickStart() { tickStartedNanos = System.nanoTime(); }

    public void onTickEnd() {
        long now = System.nanoTime();
        long start = tickStartedNanos == 0L ? now : tickStartedNanos;
        synchronized (lock) {
            tickEnds[endIndex++ % tickEnds.length] = now;
            if (endCount < tickEnds.length) endCount++;
            durations[durationIndex++ % durations.length] = Math.max(0L, now - start);
            if (durationCount < durations.length) durationCount++;
            totalTicks++;
        }
    }

    public Map<String,Object> snapshot(int online, int max, int worlds, Integer whitelistCount, Integer banCount) {
        long now = System.nanoTime();
        Runtime rt = Runtime.getRuntime();
        long used = rt.totalMemory() - rt.freeMemory();
        long maxMem = rt.maxMemory();
        Map<String,Object> root = new LinkedHashMap<>();
        synchronized (lock) {
            root.put("state", "RUNNING");
            root.put("startedAt", startedAtEpochMillis / 1000L);
            root.put("uptimeSeconds", Math.max(0L, (now - startedNanos) / 1_000_000_000L));
            root.put("ticks", totalTicks);
            root.put("players", Map.of("online", online, "maximum", max));
            root.put("worlds", worlds);
            if (whitelistCount != null) root.put("whitelist", whitelistCount);
            if (banCount != null) root.put("bans", banCount);
            root.put("memory", Map.of("usedBytes", used, "maxBytes", maxMem, "percent", round(maxMem <= 0 ? 0 : (used * 100.0 / maxMem))));
            root.put("cpu", Map.of("processPercent", osLoad("getProcessCpuLoad"), "systemPercent", osLoad("getCpuLoad")));
            root.put("tps", Map.of("current", tps(now, 5_000_000_000L), "oneMinute", tps(now, 60_000_000_000L)));
            root.put("mspt", Map.of("average", msptAverage(), "p95", percentile(0.95)));
        }
        return root;
    }

    private double tps(long now, long window) {
        int count = 0;
        for (int i = 0; i < endCount; i++) if (tickEnds[i] > 0 && now - tickEnds[i] <= window) count++;
        return round(Math.min(20.0, count / (window / 1_000_000_000.0)));
    }
    private double msptAverage() {
        if (durationCount == 0) return 0.0;
        long sum = 0; for (int i = 0; i < durationCount; i++) sum += durations[i];
        return round((sum / (double)durationCount) / 1_000_000.0);
    }
    private double percentile(double p) {
        if (durationCount == 0) return 0.0;
        long[] copy = Arrays.copyOf(durations, durationCount);
        Arrays.sort(copy);
        int idx = Math.min(copy.length - 1, Math.max(0, (int)Math.ceil(p * copy.length) - 1));
        return round(copy[idx] / 1_000_000.0);
    }
    private static Double osLoad(String method) {
        try {
            Object os = ManagementFactory.getOperatingSystemMXBean();
            Object v = os.getClass().getMethod(method).invoke(os);
            if (v instanceof Number n && n.doubleValue() >= 0) return round(n.doubleValue() * 100.0);
        } catch (Throwable ignored) {}
        return null;
    }
    private static double round(double v) { return Math.round(v * 100.0) / 100.0; }
}
