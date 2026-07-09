package com.playerpanel.fabric.server;

import net.minecraft.server.MinecraftServer;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.regex.*;

public final class FabricServerBridge {
    private final AtomicReference<MinecraftServer> server = new AtomicReference<>();
    private final MetricsTracker metricsTracker = new MetricsTracker();
    private final Deque<Map<String,Object>> eventBuffer = new ArrayDeque<>();
    private final AtomicLong eventSequence = new AtomicLong();
    private final Object eventLock = new Object();
    private static final int MAX_EVENTS = 250;
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{3,16}");

    public void attach(MinecraftServer srv) { server.set(srv); metricsTracker.reset(); event("server", Map.of("state", "online")); }
    public void detach(MinecraftServer srv) { server.compareAndSet(srv, null); event("server", Map.of("state", "offline")); }
    public boolean isOnline() { return server.get() != null; }
    public void onTickStart(MinecraftServer srv) { if (server.get() == srv) metricsTracker.onTickStart(); }
    public void onTickEnd(MinecraftServer srv) { if (server.get() == srv) metricsTracker.onTickEnd(); }

    public Map<String,Object> serverInfo() {
        MinecraftServer srv = server.get();
        Map<String,Object> m = new LinkedHashMap<>();
        m.put("online", srv != null);
        m.put("platform", "FABRIC");
        m.put("software", "Fabric");
        m.put("serverVersion", stringFrom(srv, "Fabric", "getServerVersion", "getVersion"));
        m.put("minecraftVersion", stringFrom(srv, "26.1.2", "getServerVersion", "getVersion"));
        List<Object> players = onlinePlayerObjects();
        m.put("onlinePlayers", players.size());
        m.put("maximumPlayers", intFrom(invoke(srv, "getMaxPlayers"), serverPropertyInt("max-players", 20)));
        m.put("worlds", worlds());
        m.put("whitelistEnabled", boolFrom(invoke(srv, "isEnforceWhitelist"), serverPropertyBool("white-list", false)));
        m.put("metrics", metrics());
        return m;
    }

    public Map<String,Object> metrics() {
        List<Object> players = onlinePlayerObjects();
        return metricsTracker.snapshot(players.size(), serverPropertyInt("max-players", 20), worlds().size(), whitelistEntries().size(), bannedEntries().size());
    }

    public List<Object> onlinePlayers() {
        List<Object> out = new ArrayList<>();
        for (Object p : onlinePlayerObjects()) out.add(serializePlayer(p));
        return out;
    }

    public List<Object> allPlayers() {
        Map<String,Map<String,Object>> out = new LinkedHashMap<>();
        for (Object p : onlinePlayers()) {
            Map<String,Object> mp = castMap(p); out.put(String.valueOf(mp.get("uuid")), mp);
        }
        for (Map<String,Object> e : whitelistEntries()) {
            String uuid = String.valueOf(e.getOrDefault("uuid", ""));
            out.computeIfAbsent(uuid, k -> new LinkedHashMap<>(Map.of("uuid", uuid, "name", e.getOrDefault("name", "Unknown"), "online", false, "whitelisted", true)));
        }
        return new ArrayList<>(out.values());
    }

    public Map<String,Object> playerDetails(UUID uuid) throws ControlException {
        Object p = findPlayer(uuid);
        if (p == null) return Map.of("success", true, "player", Map.of("uuid", uuid.toString(), "online", false, "name", knownName(uuid)));
        return Map.of("success", true, "player", serializePlayer(p));
    }

    public Map<String,Object> inventory(UUID uuid) throws ControlException {
        Object p = requireOnline(uuid);
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("success", true);
        result.put("uuid", uuid.toString());
        result.put("items", inventoryItems(p));
        result.put("selectedSlot", intFrom(invoke(invoke(p, "getInventory"), "getSelectedSlot"), 0));
        return result;
    }

    public Map<String,Object> heal(UUID uuid) throws ControlException {
        return onServerThread(() -> { Object p = requireOnline(uuid); invokeAny(p, new String[]{"setHealth"}, maxHealth(p)); return action(p, "heal"); });
    }
    public Map<String,Object> feed(UUID uuid) throws ControlException {
        return onServerThread(() -> { Object p = requireOnline(uuid); Object food = invoke(p, "getFoodData", "getHungerManager"); invokeAny(food, new String[]{"setFoodLevel"}, 20); invokeAny(food, new String[]{"setSaturation"}, 20.0f); return action(p, "feed"); });
    }
    public Map<String,Object> setGameMode(UUID uuid, String mode) throws ControlException { command("gamemode " + safe(mode) + " " + quote(knownName(uuid))); return Map.of("success", true, "action", "gamemode", "gamemode", mode); }
    public Map<String,Object> teleport(UUID uuid, String world, double x, double y, double z, float yaw, float pitch) throws ControlException { command("execute in " + normalizeWorld(world) + " run tp " + quote(knownName(uuid)) + " " + x + " " + y + " " + z + " " + yaw + " " + pitch); return Map.of("success", true, "action", "teleport", "location", Map.of("world", world, "x", x, "y", y, "z", z)); }
    public Map<String,Object> kick(UUID uuid, String reason) throws ControlException { command("kick " + quote(knownName(uuid)) + " " + safeReason(reason, "Kicked by Player Panel")); return Map.of("success", true, "action", "kick"); }
    public Map<String,Object> ban(UUID uuid, String reason, boolean kick) throws ControlException { command("ban " + quote(knownName(uuid)) + " " + safeReason(reason, "Banned by Player Panel")); if (kick) kick(uuid, reason); return Map.of("success", true, "action", "ban"); }
    public Map<String,Object> unban(UUID uuid) throws ControlException { command("pardon " + quote(knownName(uuid))); return Map.of("success", true, "action", "unban"); }
    public Map<String,Object> setWhitelist(UUID uuid, boolean enabled) throws ControlException { command("whitelist " + (enabled ? "add " : "remove ") + quote(knownName(uuid))); return Map.of("success", true, "action", "whitelist", "whitelisted", enabled); }
    public Map<String,Object> setOperator(UUID uuid, boolean enabled) throws ControlException { command((enabled ? "op " : "deop ") + quote(knownName(uuid))); return Map.of("success", true, "action", "operator", "operator", enabled); }
    public Map<String,Object> clearInventory(UUID uuid) throws ControlException { command("clear " + quote(knownName(uuid))); return Map.of("success", true, "action", "clear-inventory"); }
    public Map<String,Object> reloadWhitelist() throws ControlException { command("whitelist reload"); return Map.of("success", true, "action", "whitelist-reload"); }

    public Map<String,Object> addWhitelist(String name, String uuidText) throws ControlException {
        String valid = validateName(name);
        UUID uuid = uuidText == null || uuidText.isBlank() ? UUID.nameUUIDFromBytes(("OfflinePlayer:" + valid).getBytes(StandardCharsets.UTF_8)) : UUID.fromString(uuidText);
        synchronized (this) {
            List<Map<String,Object>> entries = whitelistEntries();
            entries.add(new LinkedHashMap<>(Map.of("uuid", uuid.toString(), "name", valid)));
            writeWhitelist(entries);
        }
        reloadWhitelist();
        return Map.of("success", true, "name", valid, "uuid", uuid.toString(), "whitelisted", true);
    }

    public Map<String,Object> updateWhitelistEntry(String oldUuid, String name, String newUuid) throws ControlException {
        UUID old = UUID.fromString(oldUuid); UUID next = UUID.fromString(newUuid); String valid = validateName(name);
        synchronized (this) {
            List<Map<String,Object>> entries = whitelistEntries();
            for (Map<String,Object> e : entries) if (String.valueOf(e.get("uuid")).equalsIgnoreCase(old.toString())) { e.put("uuid", next.toString()); e.put("name", valid); }
            writeWhitelist(entries);
        }
        reloadWhitelist();
        return Map.of("success", true, "oldUuid", old.toString(), "uuid", next.toString(), "name", valid);
    }

    public Map<String,Object> controlWorld(String world, String timePreset, String weather) throws ControlException {
        if (timePreset != null && !timePreset.isBlank()) command("time set " + safe(timePreset));
        if (weather != null && !weather.isBlank()) command("weather " + safe(weather));
        return Map.of("success", true, "world", world == null ? "world" : world, "timePreset", timePreset == null ? "" : timePreset, "weather", weather == null ? "" : weather);
    }

    public Map<String,Object> safePosition(String world, int x, int z) throws ControlException {
        int y = 64;
        Object level = findWorld(world);
        if (level != null) {
            try {
                Class<?> blockPos = Class.forName("net.minecraft.core.BlockPos");
                Object pos = blockPos.getConstructor(int.class, int.class, int.class).newInstance(x, 0, z);
                Object heightmap = Class.forName("net.minecraft.world.level.levelgen.Heightmap$Types").getField("MOTION_BLOCKING_NO_LEAVES").get(null);
                Object result = invokeWithArgs(level, new String[]{"getHeightmapPos"}, heightmap, pos);
                y = intFrom(invoke(result, "getY"), y);
            } catch (Throwable ignored) {}
        }
        return Map.of("success", true, "position", Map.of("world", world == null ? "world" : world, "x", x + 0.5, "y", y, "z", z + 0.5, "safe", true));
    }

    public List<Map<String,Object>> whitelistEntries() { return readNamedUuidFile(root().resolve("whitelist.json")); }
    public List<Map<String,Object>> bannedEntries() { return readNamedUuidFile(root().resolve("banned-players.json")); }
    public List<Map<String,Object>> events(long after) { synchronized (eventLock) { return eventBuffer.stream().filter(e -> ((Number)e.get("id")).longValue() > after).map(e -> (Map<String,Object>)new LinkedHashMap<String,Object>(e)).toList(); } }

    private void event(String type, Map<String,Object> data) {
        synchronized (eventLock) {
            Map<String,Object> e = new LinkedHashMap<>(); e.put("id", eventSequence.incrementAndGet()); e.put("type", type); e.put("ts", System.currentTimeMillis()/1000L); e.putAll(data);
            eventBuffer.addLast(e); while (eventBuffer.size() > MAX_EVENTS) eventBuffer.removeFirst();
        }
    }

    private Object requireOnline(UUID uuid) throws ControlException { Object p = findPlayer(uuid); if (p == null) throw new ControlException(404, "PLAYER_OFFLINE", "Player is offline"); return p; }
    private Object findPlayer(UUID uuid) { for (Object p : onlinePlayerObjects()) if (uuid.equals(playerUuid(p))) return p; return null; }
    private List<Object> onlinePlayerObjects() { Object list = invoke(server.get(), "getPlayerList"); Object players = invoke(list, "getPlayers"); if (players instanceof Collection<?> c) return new ArrayList<>(c); return List.of(); }
    private List<Object> worlds() { Object levels = invoke(server.get(), "getAllLevels", "getWorlds"); if (levels instanceof Iterable<?> it) { List<Object> out = new ArrayList<>(); for (Object w : it) out.add(Map.of("id", worldName(w), "name", worldName(w))); return out; } return List.of(Map.of("id", "world", "name", "world")); }
    private Object findWorld(String name) { for (Object w : (Iterable<?>)Optional.ofNullable(invoke(server.get(), "getAllLevels", "getWorlds")).orElse(List.of())) if (worldName(w).equalsIgnoreCase(normalizeWorld(name))) return w; return null; }

    private Map<String,Object> serializePlayer(Object p) {
        UUID uuid = playerUuid(p);
        Map<String,Object> m = new LinkedHashMap<>();
        m.put("uuid", uuid == null ? "" : uuid.toString()); m.put("name", playerName(p)); m.put("online", true);
        m.put("health", doubleFrom(invoke(p, "getHealth"), 0)); m.put("maxHealth", maxHealth(p));
        Object food = invoke(p, "getFoodData", "getHungerManager"); m.put("food", intFrom(invoke(food, "getFoodLevel", "getFoodLevel"), 0));
        m.put("gamemode", String.valueOf(invoke(invoke(p, "gameMode", "interactionManager"), "getGameModeForPlayer", "getGameMode")));
        m.put("location", location(p)); m.put("whitelisted", true); m.put("operator", false);
        return m;
    }
    private Map<String,Object> location(Object p) { return Map.of("world", worldName(invoke(p, "serverLevel", "getWorld")), "x", round(doubleFrom(invoke(p, "getX"), 0)), "y", round(doubleFrom(invoke(p, "getY"), 0)), "z", round(doubleFrom(invoke(p, "getZ"), 0)), "yaw", round(doubleFrom(invoke(p, "getYRot", "getYaw"), 0)), "pitch", round(doubleFrom(invoke(p, "getXRot", "getPitch"), 0))); }
    private List<Object> inventoryItems(Object p) { return new ArrayList<>(); }
    private Map<String,Object> action(Object p, String action) { return Map.of("success", true, "action", action, "player", serializePlayer(p)); }

    private void command(String command) throws ControlException { try { onServerThread(() -> { executeCommand(command); return null; }); } catch (ControlException e) { throw e; } }
    private void executeCommand(String command) throws ControlException {
        MinecraftServer srv = server.get(); if (srv == null) throw new ControlException(503, "SERVER_OFFLINE", "Minecraft server is not ready");
        Object commands = invoke(srv, "getCommands", "getCommandManager"); Object source = invoke(srv, "createCommandSourceStack", "getCommandSource");
        if (!invokeAny(commands, new String[]{"performPrefixedCommand", "executeWithPrefix"}, source, command) && !invokeAny(commands, new String[]{"performCommand", "execute"}, source, command)) throw new ControlException(500, "COMMAND_FAILED", "Could not execute server command");
    }
    private <T> T onServerThread(Callable<T> c) throws ControlException { try { return c.call(); } catch (ControlException e) { throw e; } catch (Exception e) { throw new ControlException(500, "ACTION_FAILED", e.getMessage()); } }

    private Path root() { Object srv = server.get(); Object path = invoke(srv, "getServerDirectory", "getRunDirectory"); if (path instanceof Path p) return p; return Paths.get("."); }
    private List<Map<String,Object>> readNamedUuidFile(Path path) { return List.of(); }
    private void writeWhitelist(List<Map<String,Object>> entries) throws ControlException { try { Files.writeString(root().resolve("whitelist.json"), com.playerpanel.fabric.json.Json.stringify(entries)); } catch (IOException e) { throw new ControlException(500, "WHITELIST_WRITE_FAILED", e.getMessage()); } }
    private Properties serverProperties() { Properties p = new Properties(); try (Reader r = Files.newBufferedReader(root().resolve("server.properties"))) { p.load(r); } catch (IOException ignored) {} return p; }
    private int serverPropertyInt(String k, int f) { try { return Integer.parseInt(serverProperties().getProperty(k, String.valueOf(f))); } catch(Exception e) { return f; } }
    private boolean serverPropertyBool(String k, boolean f) { return Boolean.parseBoolean(serverProperties().getProperty(k, String.valueOf(f))); }
    private String knownName(UUID uuid) { Object p = findPlayer(uuid); return p == null ? uuid.toString() : playerName(p); }
    private String validateName(String name) throws ControlException { String n = name == null ? "" : name.trim(); if (!NAME.matcher(n).matches()) throw new ControlException(400, "INVALID_PLAYER_NAME", "Player name must contain 3 to 16 letters, numbers, or underscores"); return n; }
    private static String normalizeWorld(String w) { if (w == null || w.isBlank() || w.equals("world")) return "minecraft:overworld"; return w.contains(":") ? w : "minecraft:" + w; }
    private static String quote(String s) { return s == null ? "" : s.replace("\\", "").replace("\"", ""); }
    private static String safe(String s) { return s == null ? "" : s.replaceAll("[^A-Za-z0-9_:-]", ""); }
    private static String safeReason(String s, String fallback) { return s == null || s.isBlank() ? fallback : s.replace('\n', ' ').replace('\r', ' '); }
    private static UUID playerUuid(Object p) { return asUuid(invoke(p, "getUUID", "getUuid")); }
    private static String playerName(Object p) { Object profile = invoke(p, "getGameProfile", "getProfile"); Object name = invoke(profile, "getName"); return name == null ? "Unknown" : String.valueOf(name); }
    private static double maxHealth(Object p) { return Math.max(20.0, doubleFrom(invoke(p, "getMaxHealth"), 20.0)); }
    private static String worldName(Object w) { Object key = invoke(w, "dimension", "getRegistryKey"); String s = String.valueOf(key == null ? "world" : key); if (s.contains("overworld")) return "world"; return s.replace("ResourceKey[minecraft:dimension / ", "").replace("]", ""); }
    @SuppressWarnings("unchecked") private static Map<String,Object> castMap(Object o) { return (Map<String,Object>)o; }
    private static Object invoke(Object target, String... names) { if (target == null) return null; for (String name : names) { try { Method m = target.getClass().getMethod(name); m.setAccessible(true); return m.invoke(target); } catch(Throwable ignored) {} } return null; }
    private static Object invokeWithArgs(Object target, String[] names, Object... args) { if (target == null) return null; for (String name : names) for (Method m : target.getClass().getMethods()) if (m.getName().equals(name) && m.getParameterCount() == args.length) { try { m.setAccessible(true); return m.invoke(target, args); } catch(Throwable ignored) {} } return null; }
    private static boolean invokeAny(Object target, String[] names, Object... args) { return invokeWithArgs(target, names, args) != null; }
    private static int intFrom(Object o, int f) { return o instanceof Number n ? n.intValue() : f; }
    private static double doubleFrom(Object o, double f) { return o instanceof Number n ? n.doubleValue() : f; }
    private static boolean boolFrom(Object o, boolean f) { return o instanceof Boolean b ? b : f; }
    private static String stringFrom(Object o, String f, String... names) { Object v = invoke(o, names); return v == null ? f : String.valueOf(v); }
    private static UUID asUuid(Object o) { try { return o instanceof UUID u ? u : UUID.fromString(String.valueOf(o)); } catch(Exception e) { return null; } }
    private static double round(double d) { return Math.round(d * 100.0) / 100.0; }

    public static final class ControlException extends Exception { public final int status; public final String code; public ControlException(int status, String code, String message) { super(message); this.status = status; this.code = code; } }
}
