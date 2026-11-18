package com.fourveko.platform.worker;

import com.fourveko.platform.json.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Envelopes of protocol vks/1 (see engine/vekoscript/crates/vks-protocol). */
public final class Protocol {
    public static final String VERSION = "vks/1";

    private Protocol() {}

    public static ObjectNode envelope(long id, String type, JsonNode payload) {
        ObjectNode e = Json.object();
        e.put("protocol", VERSION);
        e.put("id", id);
        e.put("type", type);
        if (payload != null) {
            e.set("payload", payload);
        }
        return e;
    }

    public static ObjectNode hostResult(JsonNode ok, String errorCode, String errorMessage) {
        ObjectNode p = Json.object();
        if (errorCode == null) {
            p.set("ok", ok);
            p.putNull("error");
        } else {
            p.putNull("ok");
            ObjectNode e = p.putObject("error");
            e.put("code", errorCode);
            e.put("message", errorMessage);
        }
        return p;
    }
}
