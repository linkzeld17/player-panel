package com.playerpanel.fabric;

import com.playerpanel.fabric.api.ApiServer;
import com.playerpanel.fabric.config.PanelConfig;
import com.playerpanel.fabric.server.FabricServerBridge;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import java.lang.reflect.*;
import java.util.*;
import java.util.function.Consumer;
import java.util.logging.Logger;

public final class PlayerPanelFabric implements ModInitializer {
    public static final String MOD_ID = "player-panel";
    public static final String VERSION = "1.1.7";
    public static final Logger LOGGER = Logger.getLogger(MOD_ID);
    private static final String LIFECYCLE_EVENTS = "net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents";
    private static final String TICK_EVENTS = "net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents";
    private final FabricServerBridge bridge = new FabricServerBridge();
    private volatile ApiServer apiServer;

    @Override public void onInitialize() {
        try {
            registerEvent(LIFECYCLE_EVENTS, "SERVER_STARTING", "onServerStarting", obj -> { bridge.attach((MinecraftServer)obj); startApiSafe(); });
            registerEvent(LIFECYCLE_EVENTS, "SERVER_STOPPING", "onServerStopping", obj -> { stopApi(); bridge.detach((MinecraftServer)obj); });
            registerEvent(TICK_EVENTS, "START_SERVER_TICK", "onStartTick", obj -> bridge.onTickStart((MinecraftServer)obj));
            registerEvent(TICK_EVENTS, "END_SERVER_TICK", "onEndTick", obj -> bridge.onTickEnd((MinecraftServer)obj));
            LOGGER.info("Player Panel Fabric initialized");
        } catch (Throwable t) {
            LOGGER.severe("Could not register Fabric events: " + t.getMessage());
        }
    }

    private void registerEvent(String className, String fieldName, String preferredMethod, Consumer<Object> consumer) throws ReflectiveOperationException {
        Class<?> holder = Class.forName(className);
        Object event = holder.getField(fieldName).get(null);
        Method register = Arrays.stream(event.getClass().getMethods()).filter(m -> m.getName().equals("register") && m.getParameterCount() == 1).findFirst().orElseThrow();
        Class<?> listenerType = register.getParameterTypes()[0];
        Object listener = Proxy.newProxyInstance(listenerType.getClassLoader(), new Class<?>[]{listenerType}, (proxy, method, args) -> {
            if ((method.getName().equals(preferredMethod) || method.getParameterCount() == 1) && args != null && args.length > 0) consumer.accept(args[0]);
            return null;
        });
        register.invoke(event, listener);
    }

    private void startApiSafe() {
        try { startApi(); }
        catch (Exception e) { LOGGER.severe("Could not start Player Panel API: " + e.getMessage()); }
    }
    private synchronized void startApi() throws Exception {
        if (apiServer != null) return;
        PanelConfig config = PanelConfig.load(FabricLoader.getInstance().getConfigDir());
        if (!config.apiEnabled()) { LOGGER.info("Player Panel API is disabled"); return; }
        apiServer = new ApiServer(config, bridge, VERSION);
        apiServer.start();
        LOGGER.info("Player Panel API listening on " + config.bindAddress() + ":" + config.port());
    }
    private synchronized void stopApi() {
        ApiServer current = apiServer;
        apiServer = null;
        if (current != null) current.stop();
    }
}
