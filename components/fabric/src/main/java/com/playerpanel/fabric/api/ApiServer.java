package com.playerpanel.fabric.api;

import com.playerpanel.fabric.config.PanelConfig;
import com.playerpanel.fabric.json.Json;
import com.playerpanel.fabric.security.*;
import com.playerpanel.fabric.server.FabricServerBridge;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.*;

public final class ApiServer {
    private final PanelConfig config;
    private final FabricServerBridge bridge;
    private final String version;
    private final TokenAuthenticator authenticator;
    private final RateLimiter rateLimiter;
    private HttpServer server;
    private ExecutorService executor;

    public ApiServer(PanelConfig config, FabricServerBridge bridge, String version) {
        this.config = config;
        this.bridge = bridge;
        this.version = version;
        this.authenticator = new TokenAuthenticator(config.requireToken(), config.token());
        this.rateLimiter = new RateLimiter(config.rateLimitEnabled(), config.requestsPerMinute());
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(config.bindAddress(), config.port()), 0);
        executor = Executors.newFixedThreadPool(config.workerThreads(), new ApiThreadFactory());
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
    }

    public void stop() {
        if (server != null) server.stop(1);
        if (executor != null) executor.shutdownNow();
        server = null;
        executor = null;
    }

    private void handle(HttpExchange exchange) throws IOException {
        headers(exchange);
        try {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) { send(exchange, 204, Map.of()); return; }
            String ip = Optional.ofNullable(exchange.getRemoteAddress()).map(InetSocketAddress::getAddress).map(InetAddress::getHostAddress).orElse("unknown");
            if (!rateLimiter.allow(ip)) { error(exchange, 429, "RATE_LIMITED", "Too many requests"); return; }
            if (!authenticator.authenticate(exchange.getRequestHeaders())) { error(exchange, 401, "UNAUTHORIZED", "Invalid credentials"); return; }
            route(exchange);
        } catch (FabricServerBridge.ControlException e) {
            error(exchange, e.status, e.code, e.getMessage());
        } catch (RequestException e) {
            error(exchange, e.status, e.code, e.getMessage());
        } catch (Exception e) {
            error(exchange, 500, "INTERNAL_ERROR", e.getMessage() == null ? "Internal server error" : e.getMessage());
        } finally {
            exchange.close();
        }
    }

    private void route(HttpExchange ex) throws Exception {
        String method = ex.getRequestMethod().toUpperCase(Locale.ROOT);
        String path = ex.getRequestURI().getPath();
        Map<String,Object> body = method.equals("POST") ? readJson(ex) : Map.of();

        if (method.equals("GET") && path.equals("/api/v1/health")) {
            send(ex, 200, Map.of("success", true, "ready", true, "serverOnline", bridge.isOnline(), "version", version, "platform", "FABRIC", "apiVersion", 1)); return;
        }
        if (method.equals("GET") && path.equals("/api/v1/capabilities")) {
            send(ex, 200, Map.of("success", true, "capabilities", List.of("players", "inventory-view", "whitelist", "bans", "world-control", "world-safe-position", "offline-players", "whitelist_denied"))); return;
        }
        if (method.equals("GET") && path.equals("/api/v1/server")) { send(ex, 200, Map.of("success", true, "server", bridge.serverInfo())); return; }
        if (method.equals("GET") && path.equals("/api/v1/metrics")) { send(ex, 200, Map.of("success", true, "metrics", bridge.metrics())); return; }
        if (method.equals("GET") && path.equals("/api/v1/players")) { send(ex, 200, Map.of("success", true, "players", bridge.onlinePlayers())); return; }
        if (method.equals("GET") && path.equals("/api/v1/players/all")) { send(ex, 200, Map.of("success", true, "players", bridge.allPlayers())); return; }
        if (method.equals("GET") && path.equals("/api/v1/whitelist")) { send(ex, 200, Map.of("success", true, "whitelist", bridge.whitelistEntries())); return; }
        if (method.equals("GET") && path.equals("/api/v1/bans")) { send(ex, 200, Map.of("success", true, "bans", bridge.bannedEntries())); return; }
        if (method.equals("GET") && path.equals("/api/v1/events")) { send(ex, 200, Map.of("success", true, "events", bridge.events(longParam(ex, "after", 0)))); return; }
        if (method.equals("POST") && path.equals("/api/v1/world/control")) { send(ex, 200, bridge.controlWorld(str(body, "world"), str(body, "timePreset"), str(body, "weather"))); return; }
        if (method.equals("POST") && path.equals("/api/v1/world/safe-position")) { send(ex, 200, bridge.safePosition(str(body, "world"), (int)dbl(body, "x", 0), (int)dbl(body, "z", 0))); return; }
        if (method.equals("POST") && path.equals("/api/v1/whitelist/add")) { send(ex, 200, bridge.addWhitelist(str(body, "name"), str(body, "uuid"))); return; }
        if (method.equals("POST") && path.equals("/api/v1/whitelist/update")) { send(ex, 200, bridge.updateWhitelistEntry(str(body, "oldUuid"), str(body, "name"), str(body, "newUuid"))); return; }
        if (method.equals("POST") && path.equals("/api/v1/whitelist/reload")) { send(ex, 200, bridge.reloadWhitelist()); return; }

        Matcher inv = Pattern.compile("^/api/v1/players/([0-9a-fA-F-]{36})/inventory$").matcher(path);
        if (method.equals("GET") && inv.matches()) { send(ex, 200, bridge.inventory(UUID.fromString(inv.group(1)))); return; }
        Matcher detail = Pattern.compile("^/api/v1/players/([0-9a-fA-F-]{36})$").matcher(path);
        if (method.equals("GET") && detail.matches()) { send(ex, 200, bridge.playerDetails(UUID.fromString(detail.group(1)))); return; }
        Matcher action = Pattern.compile("^/api/v1/players/([0-9a-fA-F-]{36})/([a-z-]+)$").matcher(path);
        if (method.equals("POST") && action.matches()) {
            UUID uuid = UUID.fromString(action.group(1));
            String a = action.group(2);
            Map<String,Object> result = switch (a) {
                case "heal" -> bridge.heal(uuid);
                case "feed" -> bridge.feed(uuid);
                case "gamemode" -> bridge.setGameMode(uuid, str(body, "gamemode"));
                case "teleport" -> bridge.teleport(uuid, str(body, "world"), dbl(body, "x", 0), dbl(body, "y", 64), dbl(body, "z", 0), (float)dbl(body, "yaw", 0), (float)dbl(body, "pitch", 0));
                case "kick" -> bridge.kick(uuid, str(body, "reason"));
                case "ban" -> bridge.ban(uuid, str(body, "reason"), bool(body, "kickIfOnline", true));
                case "unban" -> bridge.unban(uuid);
                case "whitelist" -> bridge.setWhitelist(uuid, bool(body, "enabled", true));
                case "operator" -> bridge.setOperator(uuid, bool(body, "enabled", true));
                case "clear-inventory" -> bridge.clearInventory(uuid);
                default -> throw new RequestException(404, "NOT_FOUND", "Action not found");
            };
            send(ex, 200, result); return;
        }
        error(ex, 404, "NOT_FOUND", "Endpoint not found");
    }

    private Map<String,Object> readJson(HttpExchange ex) throws IOException {
        int max = Math.max(1024, config.maxRequestSize());
        byte[] bytes = ex.getRequestBody().readNBytes(max + 1);
        if (bytes.length > max) throw new RequestException(413, "REQUEST_TOO_LARGE", "Request body is too large");
        String raw = new String(bytes, StandardCharsets.UTF_8).trim();
        if (raw.isEmpty()) return new LinkedHashMap<>();
        return parseObject(raw);
    }

    private static Map<String,Object> parseObject(String raw) {
        Map<String,Object> out = new LinkedHashMap<>();
        Matcher m = Pattern.compile("\\\"([^\\\"]+)\\\"\\s*:\\s*(\\\"(?:[^\\\\\\\"]|\\\\.)*\\\"|-?\\d+(?:\\.\\d+)?|true|false|null)").matcher(raw);
        while (m.find()) {
            String key = unescape(m.group(1));
            String value = m.group(2);
            if (value.startsWith("\"")) out.put(key, unescape(value.substring(1, value.length() - 1)));
            else if ("true".equals(value) || "false".equals(value)) out.put(key, Boolean.valueOf(value));
            else if ("null".equals(value)) out.put(key, null);
            else out.put(key, value.contains(".") ? Double.parseDouble(value) : Long.parseLong(value));
        }
        return out;
    }
    private static String unescape(String s) { return s.replace("\\\"", "\"").replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t").replace("\\\\", "\\"); }
    private static void headers(HttpExchange ex) { ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8"); ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*"); ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Player-Panel-Token"); ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); }
    private static void send(HttpExchange ex, int status, Map<String,?> data) throws IOException { byte[] bytes = Json.stringify(data).getBytes(StandardCharsets.UTF_8); ex.sendResponseHeaders(status, bytes.length); ex.getResponseBody().write(bytes); }
    private static void error(HttpExchange ex, int status, String code, String msg) throws IOException { send(ex, status, Map.of("success", false, "error", code, "message", msg)); }
    private static String str(Map<String,Object> m, String k) { Object v = m.get(k); return v == null ? "" : String.valueOf(v); }
    private static double dbl(Map<String,Object> m, String k, double f) { Object v = m.get(k); return v instanceof Number n ? n.doubleValue() : f; }
    private static boolean bool(Map<String,Object> m, String k, boolean f) { Object v = m.get(k); return v instanceof Boolean b ? b : f; }
    private static long longParam(HttpExchange ex, String key, long f) { try { for (String p : Optional.ofNullable(ex.getRequestURI().getQuery()).orElse("").split("&")) { String[] kv = p.split("=", 2); if (kv.length == 2 && kv[0].equals(key)) return Long.parseLong(URLDecoder.decode(kv[1], StandardCharsets.UTF_8)); } } catch(Exception ignored) {} return f; }

    private static final class ApiThreadFactory implements ThreadFactory { private final AtomicInteger idx = new AtomicInteger(); public Thread newThread(Runnable r) { Thread t = new Thread(r, "player-panel-api-" + idx.incrementAndGet()); t.setDaemon(true); return t; } }
    private static final class RequestException extends RuntimeException { final int status; final String code; RequestException(int status, String code, String msg) { super(msg); this.status = status; this.code = code; } }
}
