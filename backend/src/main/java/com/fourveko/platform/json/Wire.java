package com.fourveko.platform.json;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Values in the vks/1 wire form: {@code {"t": tag, "v": value}}. Decimals and dates travel as
 * text so no precision is lost.
 */
public final class Wire {
    public static final DateTimeFormatter DATE_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    private Wire() {}

    private static ObjectNode tagged(String tag) {
        ObjectNode n = Json.object();
        n.put("t", tag);
        return n;
    }

    public static ObjectNode nul() {
        return tagged("null");
    }

    public static ObjectNode str(String s) {
        return tagged("str").put("v", s);
    }

    public static ObjectNode integer(long v) {
        return tagged("int").put("v", v);
    }

    public static ObjectNode dec(BigDecimal v) {
        return tagged("dec").put("v", v.toPlainString());
    }

    public static ObjectNode bool(boolean v) {
        return tagged("bool").put("v", v);
    }

    public static ObjectNode date(LocalDate d) {
        return tagged("date").put("v", d.toString());
    }

    public static ObjectNode dateTime(OffsetDateTime d) {
        return tagged("dateTime").put("v", formatDateTime(d));
    }

    public static String formatDateTime(OffsetDateTime d) {
        return d.withOffsetSameInstant(ZoneOffset.UTC).truncatedTo(ChronoUnit.SECONDS).format(DATE_TIME);
    }

    public static ObjectNode ref(String kind, String type, String id) {
        ObjectNode n = tagged("ref");
        ObjectNode v = n.putObject("v");
        v.put("kind", kind);
        v.put("type", type);
        v.put("id", id);
        return n;
    }

    public static ObjectNode object(ObjectNode wireObject) {
        ObjectNode n = tagged("object");
        n.set("v", wireObject);
        return n;
    }

    public static String tag(JsonNode value) {
        return value == null || value.isNull() || value.isMissingNode() ? "null" : value.path("t").asString("null");
    }

    public static boolean isNull(JsonNode value) {
        return "null".equals(tag(value));
    }

    public static JsonNode payload(JsonNode value) {
        return value.path("v");
    }
}
