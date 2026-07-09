package com.playerpanel.fabric.json;

import java.util.*;

public final class Json {
    private Json() {}

    public static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String s) {
            string(out, s);
        } else if (value instanceof Number || value instanceof Boolean) {
            out.append(String.valueOf(value));
        } else if (value instanceof UUID uuid) {
            string(out, uuid.toString());
        } else if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) out.append(',');
                first = false;
                string(out, String.valueOf(entry.getKey()));
                out.append(':');
                write(out, entry.getValue());
            }
            out.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : iterable) {
                if (!first) out.append(',');
                first = false;
                write(out, item);
            }
            out.append(']');
        } else if (value.getClass().isArray()) {
            out.append('[');
            int len = java.lang.reflect.Array.getLength(value);
            for (int i = 0; i < len; i++) {
                if (i > 0) out.append(',');
                write(out, java.lang.reflect.Array.get(value, i));
            }
            out.append(']');
        } else {
            string(out, String.valueOf(value));
        }
    }

    private static void string(StringBuilder out, String value) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int)c));
                    else out.append(c);
                }
            }
        }
        out.append('"');
    }
}
