package com.fourveko.platform.api;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Json;
import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.DocumentMeta;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.metadata.Metadata.RowsMeta;
import com.fourveko.platform.storage.ObjectStore;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The REST representation: plain JSON with decimals as strings, references as
 * {@code {"type", "id"}}, dates as ISO text. Converted to and from the wire form using metadata.
 */
public final class Plain {
    private Plain() {}

    public static JsonNode value(JsonNode wire) {
        return value(wire, Map.of());
    }

    /**
     * A wire value as plain JSON. {@code names} maps "Type/id" to display text; references found
     * there get a {@code display}.
     */
    public static JsonNode value(JsonNode wire, Map<String, String> names) {
        JsonNode v = Wire.payload(wire);
        return switch (Wire.tag(wire)) {
            case "null" -> Json.MAPPER.nullNode();
            case "bool" -> Json.MAPPER.getNodeFactory().booleanNode(v.asBoolean());
            case "int", "duration" -> Json.MAPPER.getNodeFactory().numberNode(v.asLong());
            case "dec", "str", "date", "dateTime" -> Json.MAPPER.getNodeFactory().stringNode(v.asString());
            case "money" -> {
                ObjectNode m = Json.object();
                m.put("amount", v.path("amount").asString());
                m.put("currency", v.path("currency").asString());
                yield m;
            }
            case "array" -> {
                ArrayNode a = Json.array();
                for (JsonNode x : v) a.add(value(x, names));
                yield a;
            }
            case "map" -> {
                ObjectNode m = Json.object();
                for (JsonNode pair : v) m.set(pair.get(0).asString(), value(pair.get(1), names));
                yield m;
            }
            case "ref" -> {
                ObjectNode r = Json.object();
                r.put("type", v.path("type").asString());
                r.put("id", v.path("id").asString());
                String display = names.get(v.path("type").asString() + "/" + v.path("id").asString());
                if (display != null) r.put("display", display);
                yield r;
            }
            case "object" -> object(v, names);
            default -> Json.MAPPER.nullNode();
        };
    }

    public static ObjectNode object(JsonNode o) {
        return object(o, Map.of());
    }

    public static ObjectNode object(JsonNode o, Map<String, String> names) {
        ObjectNode out = Json.object();
        out.put("id", o.path("id").asString());
        out.put("type", o.path("type").asString());
        String display = names.get(o.path("type").asString() + "/" + o.path("id").asString());
        if (display != null) out.put("display", display);
        out.put("version", o.path("version").asLong());
        out.put("deleted", o.path("deleted").asBoolean());
        if ("document".equals(o.path("kind").asString())) {
            out.put("number", o.path("number").asString());
            out.put("date", o.path("date").asString());
            out.put("status", o.path("status").asString());
        }
        ObjectNode fields = out.putObject("fields");
        for (var e : o.path("fields").properties()) fields.set(e.getKey(), value(e.getValue(), names));
        if ("document".equals(o.path("kind").asString())) {
            ObjectNode rows = out.putObject("rows");
            for (var e : o.path("rows").properties()) {
                ArrayNode list = rows.putArray(e.getKey());
                for (JsonNode r : e.getValue()) {
                    ObjectNode row = list.addObject();
                    row.put("lineNo", r.path("lineNo").asInt());
                    for (var f : r.path("fields").properties()) row.set(f.getKey(), value(f.getValue(), names));
                }
            }
        }
        return out;
    }

    private static PlatformException bad(String owner, FieldMeta f) {
        return PlatformException.validation(owner + ": \"" + f.name() + "\" must be " + f.type().describe() + ".");
    }

    /** A plain JSON value for a field, in wire form. Shape errors are 422; range checks come later. */
    public static JsonNode field(String owner, FieldMeta f, JsonNode v) {
        if (v == null || v.isNull() || v.isMissingNode()) return Wire.nul();
        try {
            return switch (f.type().kind()) {
                case "string" -> {
                    if (!v.isString()) throw bad(owner, f);
                    yield Wire.str(v.asString());
                }
                case "decimal" -> {
                    if (!(v.isNumber() || v.isString())) throw bad(owner, f);
                    yield Wire.dec(v.isNumber() ? v.decimalValue() : new BigDecimal(v.asString().trim()));
                }
                case "integer" -> {
                    BigDecimal d = v.isNumber() ? v.decimalValue() : v.isString() ? new BigDecimal(v.asString().trim()) : null;
                    if (d == null) throw bad(owner, f);
                    yield Wire.integer(d.longValueExact());
                }
                case "boolean" -> {
                    if (!v.isBoolean()) throw bad(owner, f);
                    yield Wire.bool(v.asBoolean());
                }
                case "date" -> Wire.date(LocalDate.parse(v.asString()));
                case "dateTime" -> Wire.dateTime(OffsetDateTime.parse(v.asString()));
                case "ref" -> {
                    String id = v.isObject() ? v.path("id").asString("") : v.asString("");
                    if (!ObjectStore.isUuid(id)) throw bad(owner, f);
                    yield Wire.ref(f.type().targetKind(), f.type().target(), id);
                }
                default -> throw bad(owner, f);
            };
        } catch (NumberFormatException | ArithmeticException | DateTimeParseException e) {
            throw bad(owner, f);
        }
    }

    /** The declared default of a field, in wire form. */
    public static JsonNode defaultValue(FieldMeta f) {
        JsonNode d = f.defaultValue();
        if (d == null || d.isNull()) return Wire.nul();
        JsonNode v = d.path("value");
        return switch (d.path("type").asString()) {
            case "integer" -> Wire.integer(v.asLong());
            case "decimal" -> Wire.dec(new BigDecimal(v.asString()));
            case "boolean" -> Wire.bool(v.asBoolean());
            case "string" -> "date".equals(f.type().kind()) ? Wire.date(LocalDate.parse(v.asString())) : Wire.str(v.asString());
            default -> Wire.nul();
        };
    }

    private static ObjectNode fields(String owner, List<FieldMeta> declared, JsonNode input, JsonNode base, boolean defaults) {
        if (!input.isMissingNode() && !input.isObject()) throw PlatformException.badRequest(owner + ": \"fields\" must be an object.");
        for (String k : input.propertyNames()) {
            if (declared.stream().noneMatch(f -> f.name().equals(k))) throw PlatformException.validation(owner + " has no field \"" + k + "\".");
        }
        ObjectNode out = Json.object();
        for (FieldMeta f : declared) {
            if (input.has(f.name())) {
                out.set(f.name(), field(owner, f, input.get(f.name())));
            } else if (base != null && base.has(f.name())) {
                out.set(f.name(), base.get(f.name()));
            } else {
                out.set(f.name(), defaults ? defaultValue(f) : Wire.nul());
            }
        }
        return out;
    }

    /**
     * Build the wire object to save from a request body: new ({@code existing == null}, defaults
     * apply) or an update of {@code existing} (fields and row sets not mentioned are kept).
     */
    public static ObjectNode toWire(Model m, String kind, String type, JsonNode body, ObjectNode existing) {
        if (!body.isObject()) throw PlatformException.badRequest("The request body must be a JSON object.");
        ObjectNode o = Json.object();
        o.put("kind", kind);
        o.put("type", type);
        if (existing != null) {
            o.put("id", existing.path("id").asString());
            if (!body.path("version").isNumber()) throw PlatformException.badRequest("Send the \"version\" you read, so concurrent changes are detected.");
            o.put("version", body.path("version").asLong());
        }
        boolean isDoc = "document".equals(kind);
        if (isDoc) {
            JsonNode date = body.path("date");
            if (date.isString()) {
                try {
                    o.put("date", LocalDate.parse(date.asString()).toString());
                } catch (DateTimeParseException e) {
                    throw PlatformException.validation(type + ": \"date\" must be a date (YYYY-MM-DD).");
                }
            } else if (existing != null) {
                o.put("date", existing.path("date").asString());
            }
        }
        o.set("fields", fields(type, m.fieldsOf(type), body.path("fields"), existing == null ? null : existing.path("fields"), existing == null));
        ObjectNode rows = o.putObject("rows");
        if (isDoc) {
            DocumentMeta d = m.document(type).orElseThrow();
            JsonNode inRows = body.path("rows");
            for (String k : inRows.propertyNames()) {
                if (d.rows().stream().noneMatch(r -> r.name().equals(k))) throw PlatformException.validation(type + " has no rows \"" + k + "\".");
            }
            for (RowsMeta r : d.rows()) {
                if (inRows.has(r.name())) {
                    ArrayNode list = rows.putArray(r.name());
                    int line = 0;
                    for (JsonNode row : inRows.get(r.name())) {
                        line++;
                        ObjectNode wr = list.addObject();
                        wr.putNull("lineNo");
                        ObjectNode copy = row.isObject() ? ((ObjectNode) row).deepCopy() : Json.object();
                        copy.remove("lineNo");
                        wr.set("fields", fields(type + " " + r.name() + " line " + line, r.fields(), copy, null, true));
                    }
                } else if (existing != null) {
                    rows.set(r.name(), existing.path("rows").path(r.name()));
                } else {
                    rows.putArray(r.name());
                }
            }
        }
        return o;
    }
}
