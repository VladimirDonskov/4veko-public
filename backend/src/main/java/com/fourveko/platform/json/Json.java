package com.fourveko.platform.json;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/** One JSON mapper for the worker protocol and stored documents. */
public final class Json {
    public static final JsonMapper MAPPER = JsonMapper.builder().build();

    private Json() {}

    public static ObjectNode object() {
        return MAPPER.createObjectNode();
    }

    public static ArrayNode array() {
        return MAPPER.createArrayNode();
    }

    public static JsonNode parse(String text) {
        return MAPPER.readTree(text);
    }

    public static String write(Object value) {
        return MAPPER.writeValueAsString(value);
    }

    public static <T> T convert(JsonNode node, Class<T> type) {
        return MAPPER.treeToValue(node, type);
    }

    public static JsonNode tree(Object value) {
        return MAPPER.valueToTree(value);
    }
}
