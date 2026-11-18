package com.fourveko.platform.storage;

import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * How records are named to people: a catalog item by its {@code name} field (else {@code code},
 * else its first text field), a document by its number and date. Used for references in forms
 * and lists, so clients never need one request per referenced record.
 */
@Component
public class Presentations {
    private final JdbcTemplate jdbc;

    public Presentations(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The field that names a catalog item, if any. */
    public static Optional<FieldMeta> namingField(Model m, String catalog) {
        List<FieldMeta> fields = m.fieldsOf(catalog);
        for (String preferred : List.of("name", "code")) {
            for (FieldMeta f : fields) {
                if (f.name().equals(preferred) && "string".equals(f.type().kind())) return Optional.of(f);
            }
        }
        return fields.stream().filter(f -> "string".equals(f.type().kind())).findFirst();
    }

    private static String shortId(String id) {
        return id.length() > 8 ? id.substring(0, 8) : id;
    }

    /** Display text of a wire object. */
    public static String of(Model m, JsonNode o) {
        String type = o.path("type").asString();
        String id = o.path("id").asString("");
        if ("document".equals(o.path("kind").asString())) {
            return o.path("number").asString(shortId(id)) + " · " + o.path("date").asString("");
        }
        return namingField(m, type).map(f -> o.path("fields").path(f.name())).filter(v -> !Wire.isNull(v)).map(v -> Wire.payload(v).asString()).orElse(shortId(id));
    }

    /** Display text of records of one type, by id. Unknown ids are left out. */
    public Map<String, String> of(String schema, Model m, String type, Collection<String> ids) {
        Map<String, String> out = new HashMap<>();
        List<String> valid = ids.stream().filter(ObjectStore::isUuid).distinct().toList();
        String kind = m.kindOf(type).orElse(null);
        if (valid.isEmpty() || kind == null) return out;
        String in = String.join(", ", valid.stream().map(x -> "?::uuid").toList());
        if ("document".equals(kind)) {
            jdbc.query("SELECT id::text AS id, number, date::text AS date FROM " + Sql.documentTable(schema, type) + " WHERE id IN (" + in + ")",
                    rs -> {
                        out.put(rs.getString("id"), rs.getString("number") + " · " + rs.getString("date"));
                    }, valid.toArray());
        } else {
            Optional<FieldMeta> naming = namingField(m, type);
            String col = naming.map(f -> Sql.col(f.name())).orElse("NULL");
            jdbc.query("SELECT id::text AS id, " + col + " AS display FROM " + Sql.catalogTable(schema, type) + " WHERE id IN (" + in + ")", rs -> {
                String d = rs.getString("display");
                out.put(rs.getString("id"), d == null ? shortId(rs.getString("id")) : d);
            }, valid.toArray());
        }
        return out;
    }

    /** Collect the references inside wire values (fields, rows, dimensions) by target type. */
    public static void collect(JsonNode node, Map<String, java.util.Set<String>> into) {
        if (node == null) return;
        if (node.isObject() && "ref".equals(node.path("t").asString(""))) {
            JsonNode v = node.path("v");
            into.computeIfAbsent(v.path("type").asString(), k -> new java.util.HashSet<>()).add(v.path("id").asString());
            return;
        }
        for (JsonNode child : node.values()) collect(child, into);
    }

    /** Display text for every reference found in the given wire values: "Type/id" → text. */
    public Map<String, String> forReferences(String schema, Model m, Collection<? extends JsonNode> values) {
        Map<String, java.util.Set<String>> refs = new HashMap<>();
        for (JsonNode v : values) collect(v, refs);
        Map<String, String> out = new HashMap<>();
        for (var e : refs.entrySet()) {
            of(schema, m, e.getKey(), e.getValue()).forEach((id, text) -> out.put(e.getKey() + "/" + id, text));
        }
        return out;
    }
}
