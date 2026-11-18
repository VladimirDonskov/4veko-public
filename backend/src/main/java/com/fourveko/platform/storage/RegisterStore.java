package com.fourveko.platform.storage;

import static com.fourveko.platform.storage.Sql.col;

import com.fourveko.platform.json.Json;
import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.metadata.Metadata.RegisterMeta;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/** Register movements and balances. Balances are computed from active movements. */
@Component
public class RegisterStore {
    private final JdbcTemplate jdbc;

    public RegisterStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(String schema, RegisterMeta r, String recorderType, String recorderId, LocalDate period, int lineNo, String direction, JsonNode dims, JsonNode measures) {
        List<String> cols = new ArrayList<>(List.of("period", "recorder_type", "recorder_id", "line_no", "direction"));
        List<String> marks = new ArrayList<>(List.of("?::date", "?", "?::uuid", "?", "?"));
        List<Object> args = new ArrayList<>(List.of(period.toString(), recorderType, recorderId, lineNo, direction));
        for (FieldMeta d : r.dimensions()) {
            cols.add(col(d.name()));
            marks.add(Fields.placeholder(d.type()));
            args.add(Fields.toSql(d, dims.path(d.name())));
        }
        for (FieldMeta m : r.values()) {
            cols.add(col(m.name()));
            marks.add(Fields.placeholder(m.type()));
            args.add(Fields.toSql(m, measures.path(m.name())));
        }
        jdbc.update("INSERT INTO " + Sql.registerTable(schema, r.name()) + " (" + String.join(", ", cols) + ") VALUES (" + String.join(", ", marks) + ")", args.toArray());
    }

    /** Deactivate every movement a document made, in all registers. Returns how many. */
    public int deactivate(String schema, Model m, String recorderType, String recorderId) {
        int n = 0;
        for (RegisterMeta r : m.registers()) {
            n += jdbc.update("UPDATE " + Sql.registerTable(schema, r.name()) + " SET active = false WHERE recorder_type = ? AND recorder_id = ?::uuid AND active", recorderType, recorderId);
        }
        return n;
    }

    /**
     * Totals of the measures over active movements matching the given dimensions, up to and
     * including {@code at} when given. Increases add, decreases subtract.
     */
    public ObjectNode balance(String schema, RegisterMeta r, Map<String, JsonNode> filter, LocalDate at) {
        List<String> sums = new ArrayList<>();
        for (FieldMeta m : r.values()) {
            sums.add("COALESCE(SUM(CASE WHEN direction = 'in' THEN " + col(m.name()) + " ELSE -" + col(m.name()) + " END), 0) AS " + Sql.q("s_" + m.name()));
        }
        StringBuilder where = new StringBuilder("active");
        List<Object> args = new ArrayList<>();
        for (FieldMeta d : r.dimensions()) {
            JsonNode v = filter.get(d.name());
            if (v != null) {
                where.append(" AND ").append(col(d.name())).append(" = ").append(Fields.placeholder(d.type()));
                args.add(Fields.toSql(d, v));
            }
        }
        if (at != null) {
            where.append(" AND period <= ?::date");
            args.add(at.toString());
        }
        ObjectNode out = Json.object();
        jdbc.query("SELECT " + String.join(", ", sums) + " FROM " + Sql.registerTable(schema, r.name()) + " WHERE " + where, rs -> {
            for (FieldMeta m : r.values()) {
                BigDecimal v = rs.getBigDecimal("s_" + m.name());
                out.set(m.name(), "integer".equals(m.type().kind()) ? Wire.integer(v.longValueExact()) : Wire.dec(v.setScale(m.type().scale())));
            }
        }, args.toArray());
        return out;
    }

    /** Movements recorded by a document (active and reversed), for inspection and audit. */
    public ArrayNode movements(String schema, RegisterMeta r, String recorderId) {
        ArrayNode out = Json.array();
        jdbc.query("SELECT * FROM " + Sql.registerTable(schema, r.name()) + " WHERE recorder_id = ?::uuid ORDER BY id", rs -> {
            ObjectNode m = out.addObject();
            m.put("period", rs.getObject("period", LocalDate.class).toString());
            m.put("lineNo", rs.getInt("line_no"));
            m.put("direction", rs.getString("direction"));
            m.put("active", rs.getBoolean("active"));
            ObjectNode dims = m.putObject("dimensions");
            for (FieldMeta d : r.dimensions()) dims.set(d.name(), Fields.fromSql(d, rs, "f_" + d.name()));
            ObjectNode ms = m.putObject("measures");
            for (FieldMeta v : r.values()) ms.set(v.name(), Fields.fromSql(v, rs, "f_" + v.name()));
        }, recorderId);
        return out;
    }
}
