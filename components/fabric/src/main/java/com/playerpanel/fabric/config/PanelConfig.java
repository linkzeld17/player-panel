package com.playerpanel.fabric.config;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.*;

public record PanelConfig(
        boolean apiEnabled,
        String bindAddress,
        int port,
        int workerThreads,
        int maxRequestSize,
        boolean requireToken,
        String token,
        boolean rateLimitEnabled,
        int requestsPerMinute
) {
    public static PanelConfig load(Path configDir) throws IOException {
        Files.createDirectories(configDir);
        Path file = configDir.resolve("player-panel-fabric.properties");
        Properties props = new Properties();
        if (Files.exists(file)) {
            try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) { props.load(r); }
        }
        boolean changed = false;
        changed |= putDefault(props, "api.enabled", "true");
        changed |= putDefault(props, "api.bind-address", "0.0.0.0");
        changed |= putDefault(props, "api.port", "8765");
        changed |= putDefault(props, "api.worker-threads", "4");
        changed |= putDefault(props, "api.max-request-size", "1048576");
        changed |= putDefault(props, "api.require-token", "true");
        if (!props.containsKey("api.token") || props.getProperty("api.token", "").isBlank() || props.getProperty("api.token").equals("CHANGE_ME")) {
            props.setProperty("api.token", randomToken());
            changed = true;
        }
        changed |= putDefault(props, "api.rate-limit.enabled", "true");
        changed |= putDefault(props, "api.rate-limit.requests-per-minute", "120");
        if (changed || !Files.exists(file)) {
            try (Writer w = Files.newBufferedWriter(file, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
                props.store(w, "Player Panel Fabric API configuration");
            }
        }
        return new PanelConfig(
                bool(props, "api.enabled", true),
                props.getProperty("api.bind-address", "0.0.0.0").trim(),
                integer(props, "api.port", 8765, 1, 65535),
                integer(props, "api.worker-threads", 4, 1, 64),
                integer(props, "api.max-request-size", 1048576, 1024, 16 * 1024 * 1024),
                bool(props, "api.require-token", true),
                props.getProperty("api.token", "").trim(),
                bool(props, "api.rate-limit.enabled", true),
                integer(props, "api.rate-limit.requests-per-minute", 120, 1, 10000)
        );
    }

    private static boolean putDefault(Properties p, String key, String value) {
        if (p.containsKey(key)) return false;
        p.setProperty(key, value);
        return true;
    }
    private static boolean bool(Properties p, String key, boolean fallback) {
        return Boolean.parseBoolean(p.getProperty(key, String.valueOf(fallback)).trim());
    }
    private static int integer(Properties p, String key, int fallback, int min, int max) {
        try { return Math.max(min, Math.min(max, Integer.parseInt(p.getProperty(key, String.valueOf(fallback)).trim()))); }
        catch (Exception e) { return fallback; }
    }
    private static String randomToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
