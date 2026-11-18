package com.fourveko.platform.storage;

import static com.fourveko.platform.storage.Sql.col;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Json;
import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.DocumentMeta;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.metadata.Metadata.RowsMeta;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Catalog items and documents in their generated tables, read and written in the wire form the
 * engine uses ({@code WireObject}).
 */
@Component
public class ObjectStore {
    private final JdbcTemplate jdbc;

    public ObjectStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static String kindOf(Model m, String type) {
        return m.kindOf(type).orElseThrow(() -> PlatformException.notFound("This application has no catalog or document named \"" + type + "\"."));
    }

    private ObjectNode read(ResultSet rs, Model m, String type, String kind) throws SQLException {
        ObjectNode o = Json.object();
        o.put("kind", kind);
        o.put("type", type);
        o.put("id", rs.getString("id"));
        o.put("version", rs.getLong("version"));
        o.put("deleted", rs.getBoolean("deleted"));
        if ("document".equals(kind)) {
            o.put("number", rs.getString("number"));
            o.put("date", rs.getObject("date", LocalDate.class).toString());
            o.put("status", rs.getString("status"));
        }
        ObjectNode fields = o.putObject("fields");
        for (FieldMeta f : m.fieldsOf(type)) {
            fields.set(f.name(), Fields.fromSql(f, rs, "f_" + f.name()));
        }
        o.putObject("rows");
        return o;
    }

    private void readRows(String schema, Model m, ObjectNode o) {
        DocumentMeta d = m.document(o.path("type").asString()).orElseThrow();
        ObjectNode rows = (ObjectNode) o.get("rows");
        for (RowsMeta r : d.rows()) {
            ArrayNode list = rows.putArray(r.name());
            jdbc.query("SELECT * FROM " + Sql.rowsTable(schema, d.name(), r.name()) + " WHERE document_id = ?::uuid ORDER BY line_no", rs -> {
                ObjectNode row = Json.object();
                row.put("lineNo", rs.getInt("line_no"));
                ObjectNode fields = row.putObject("fields");
                for (FieldMeta f : r.fields()) {
                    fields.set(f.name(), Fields.fromSql(f, rs, "f_" + f.name()));
                }
                list.add(row);
            }, o.path("id").asString());
        }
    }

    private List<ObjectNode> select(String schema, Model m, String type, String where, boolean forUpdate, Object... args) {
        String kind = kindOf(m, type);
        String sql = "SELECT * FROM " + Sql.objectTable(schema, kind, type) + " WHERE " + where + (forUpdate ? " FOR UPDATE" : "");
        List<ObjectNode> found = jdbc.query(sql, (rs, i) -> read(rs, m, type, kind), args);
        if ("document".equals(kind)) {
            for (ObjectNode o : found) readRows(schema, m, o);
        }
        return found;
    }

    /** The object with this id (including archived ones), or null. */
    public ObjectNode find(String schema, Model m, String type, String id, boolean forUpdate) {
        if (!isUuid(id)) return null;
        List<ObjectNode> found = select(schema, m, type, "id = ?::uuid", forUpdate, id);
        return found.isEmpty() ? null : found.getFirst();
    }

    public ObjectNode findBy(String schema, Model m, String type, String field, JsonNode value) {
        String kind = kindOf(m, type);
        if ("number".equals(field) && "document".equals(kind)) {
            List<ObjectNode> found = select(schema, m, type, "number = ? AND NOT deleted ORDER BY created_at LIMIT 1", false, Wire.payload(value).asString());
            return found.isEmpty() ? null : found.getFirst();
        }
        FieldMeta f = field(m, type, field);
        Fields.check(type, new FieldMeta(f.name(), f.type(), false, false, null), value);
        List<ObjectNode> found = select(schema, m, type, col(f.name()) + " = " + Fields.placeholder(f.type()) + " AND NOT deleted ORDER BY created_at LIMIT 1", false, Fields.toSql(f, value));
        return found.isEmpty() ? null : found.getFirst();
    }

    public List<ObjectNode> list(String schema, Model m, String type, Map<String, JsonNode> filter, int limit, int offset) {
        return list(schema, m, type, filter, null, limit, offset);
    }

    /**
     * Live records matching the filter (equality per field) and, when {@code search} is given,
     * containing it in a text field or the document number (case-insensitive).
     */
    public List<ObjectNode> list(String schema, Model m, String type, Map<String, JsonNode> filter, String search, int limit, int offset) {
        StringBuilder where = new StringBuilder("NOT deleted");
        List<Object> args = new ArrayList<>();
        if (search != null && !search.isBlank()) {
            String pattern = "%" + search.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
            List<String> any = new ArrayList<>();
            if ("document".equals(kindOf(m, type))) {
                any.add("number ILIKE ?");
                args.add(pattern);
            }
            for (FieldMeta f : m.fieldsOf(type)) {
                if ("string".equals(f.type().kind())) {
                    any.add(col(f.name()) + " ILIKE ?");
                    args.add(pattern);
                }
            }
            where.append(any.isEmpty() ? " AND false" : " AND (" + String.join(" OR ", any) + ")");
        }
        for (var e : filter.entrySet()) {
            FieldMeta f = field(m, type, e.getKey());
            if (Wire.isNull(e.getValue())) {
                where.append(" AND ").append(col(f.name())).append(" IS NULL");
            } else {
                Fields.check(type, new FieldMeta(f.name(), f.type(), false, false, null), e.getValue());
                where.append(" AND ").append(col(f.name())).append(" = ").append(Fields.placeholder(f.type()));
                args.add(Fields.toSql(f, e.getValue()));
            }
        }
        where.append(" ORDER BY created_at, id LIMIT ? OFFSET ?");
        args.add(Math.min(Math.max(limit, 1), 1000));
        args.add(Math.max(offset, 0));
        return select(schema, m, type, where.toString(), false, args.toArray());
    }

    public boolean exists(String schema, Model m, String type, String id) {
        if (!isUuid(id)) return false;
        String kind = m.kindOf(type).orElse(null);
        if (kind == null) return false;
        Integer n = jdbc.queryForObject("SELECT count(*) FROM " + Sql.objectTable(schema, kind, type) + " WHERE id = ?::uuid", Integer.class, id);
        return n != null && n > 0;
    }

    /** Is another live record already using this value of a unique field? */
    public boolean taken(String schema, Model m, String type, FieldMeta f, JsonNode value, String exceptId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM " + Sql.catalogTable(schema, type) + " WHERE " + col(f.name()) + " = " + Fields.placeholder(f.type())
                + " AND NOT deleted AND id <> ?::uuid", Integer.class, Fields.toSql(f, value), exceptId == null ? new UUID(0, 0).toString() : exceptId);
        return n != null && n > 0;
    }

    public String nextNumber(String schema, String type) {
        Long n = jdbc.queryForObject("SELECT nextval('" + Sql.numberSequence(schema, type).replace("'", "''") + "')", Long.class);
        String prefix = type.chars().filter(Character::isUpperCase).collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append).toString();
        return (prefix.isEmpty() ? type.substring(0, Math.min(2, type.length())).toUpperCase() : prefix) + "-" + String.format("%06d", n);
    }

    /** Insert a new object (id, version and, for documents, number/date/status already set). */
    public void insert(String schema, Model m, ObjectNode o) {
        String type = o.path("type").asString();
        String kind = kindOf(m, type);
        List<String> cols = new ArrayList<>(List.of("id", "version", "deleted"));
        List<String> marks = new ArrayList<>(List.of("?::uuid", "?", "?"));
        List<Object> args = new ArrayList<>(List.of(o.path("id").asString(), o.path("version").asLong(), o.path("deleted").asBoolean(false)));
        if ("document".equals(kind)) {
            cols.addAll(List.of("number", "date", "status"));
            marks.addAll(List.of("?", "?::date", "?"));
            args.addAll(List.of(o.path("number").asString(), o.path("date").asString(), o.path("status").asString()));
        }
        for (FieldMeta f : m.fieldsOf(type)) {
            cols.add(col(f.name()));
            marks.add(Fields.placeholder(f.type()));
            args.add(Fields.toSql(f, o.path("fields").path(f.name())));
        }
        jdbc.update("INSERT INTO " + Sql.objectTable(schema, kind, type) + " (" + String.join(", ", cols) + ") VALUES (" + String.join(", ", marks) + ")", args.toArray());
        if ("document".equals(kind)) writeRows(schema, m, o);
    }

    /** Update fields of an existing object; false when its version changed meanwhile. */
    public boolean update(String schema, Model m, ObjectNode o, long expectedVersion) {
        String type = o.path("type").asString();
        String kind = kindOf(m, type);
        List<String> sets = new ArrayList<>(List.of("version = version + 1", "updated_at = now()"));
        List<Object> args = new ArrayList<>();
        if ("document".equals(kind)) {
            sets.add("date = ?::date");
            args.add(o.path("date").asString());
        }
        for (FieldMeta f : m.fieldsOf(type)) {
            sets.add(col(f.name()) + " = " + Fields.placeholder(f.type()));
            args.add(Fields.toSql(f, o.path("fields").path(f.name())));
        }
        args.add(o.path("id").asString());
        args.add(expectedVersion);
        int n = jdbc.update("UPDATE " + Sql.objectTable(schema, kind, type) + " SET " + String.join(", ", sets) + " WHERE id = ?::uuid AND version = ? AND NOT deleted", args.toArray());
        if (n == 1 && "document".equals(kind)) {
            DocumentMeta d = m.document(type).orElseThrow();
            for (RowsMeta r : d.rows()) {
                jdbc.update("DELETE FROM " + Sql.rowsTable(schema, type, r.name()) + " WHERE document_id = ?::uuid", o.path("id").asString());
            }
            writeRows(schema, m, o);
        }
        return n == 1;
    }

    private void writeRows(String schema, Model m, ObjectNode o) {
        String type = o.path("type").asString();
        DocumentMeta d = m.document(type).orElseThrow();
        for (RowsMeta r : d.rows()) {
            int line = 0;
            for (JsonNode row : o.path("rows").path(r.name())) {
                line++;
                List<String> cols = new ArrayList<>(List.of("document_id", "line_no"));
                List<String> marks = new ArrayList<>(List.of("?::uuid", "?"));
                List<Object> args = new ArrayList<>(List.of(o.path("id").asString(), line));
                for (FieldMeta f : r.fields()) {
                    cols.add(col(f.name()));
                    marks.add(Fields.placeholder(f.type()));
                    args.add(Fields.toSql(f, row.path("fields").path(f.name())));
                }
                jdbc.update("INSERT INTO " + Sql.rowsTable(schema, type, r.name()) + " (" + String.join(", ", cols) + ") VALUES (" + String.join(", ", marks) + ")", args.toArray());
            }
        }
    }

    /** Change a document's status, or archive an object; bumps the version. */
    public void setState(String schema, Model m, String type, String id, String status, boolean deleted) {
        String kind = kindOf(m, type);
        if (status != null) {
            jdbc.update("UPDATE " + Sql.objectTable(schema, kind, type) + " SET status = ?, version = version + 1, updated_at = now() WHERE id = ?::uuid", status, id);
        } else {
            jdbc.update("UPDATE " + Sql.objectTable(schema, kind, type) + " SET deleted = ?, version = version + 1, updated_at = now() WHERE id = ?::uuid", deleted, id);
        }
    }

    private static FieldMeta field(Model m, String type, String name) {
        return m.fieldsOf(type).stream().filter(f -> f.name().equals(name)).findFirst()
                .orElseThrow(() -> PlatformException.validation(type + " has no field \"" + name + "\"."));
    }

    public static boolean isUuid(String s) {
        try {
            UUID.fromString(s);
            return s.length() == 36;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
