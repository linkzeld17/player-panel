package com.playerpanel.fabric.security;

import com.sun.net.httpserver.Headers;
import java.security.MessageDigest;

public final class TokenAuthenticator {
    private final boolean required;
    private final String token;

    public TokenAuthenticator(boolean required, String token) {
        this.required = required;
        this.token = token == null ? "" : token.trim();
    }

    public boolean authenticate(Headers headers) {
        if (!required) return true;
        String provided = first(headers, "Authorization");
        if (provided != null && provided.regionMatches(true, 0, "Bearer ", 0, 7)) {
            provided = provided.substring(7).trim();
        } else {
            provided = first(headers, "X-Player-Panel-Token");
        }
        if (provided == null) return false;
        return MessageDigest.isEqual(token.getBytes(java.nio.charset.StandardCharsets.UTF_8), provided.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static String first(Headers h, String key) {
        var list = h.get(key);
        return list == null || list.isEmpty() ? null : list.get(0);
    }
}
