package com.fourveko.platform.storage;

import static com.fourveko.platform.storage.Sql.col;
import static com.fourveko.platform.storage.Sql.q;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Json;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.metadata.Metadata.RegisterMeta;
import com.fourveko.platform.metadata.Metadata.RowsMeta;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.util.DigestUtils;
import tools.jackson.databind.JsonNode;

/**
 * Turns the engine's logical migration plan into PostgreSQL DDL. Runs inside the deployment
 * transaction (PostgreSQL DDL is transactional), so a failed step leaves nothing behind.
 */
@Component
public class SchemaManager {
    private final JdbcTemplate jdbc;

    public SchemaManager(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private record ForeignKey(String table, String column, String targetTable) {}

    public void createSchema(String schema) {
        jdbc.execute("CREATE SCHEMA IF NOT EXISTS " + q(Sql.checked(schema)));
    }

    public List<String> apply(String schema, Model old, Model next, JsonNode steps) {
        List<String> ddl = new ArrayList<>();
        List<ForeignKey> fks = new ArrayList<>();
        for (JsonNode step : steps) {
            String op = step.path("op").asString();
            switch (op) {
                case "createCatalog" -> {
                    String name = step.path("name").asString();
                    var c = next.catalog(name).orElseThrow();
                    String table = Sql.catalogTable(schema, name);
                    List<String> cols = new ArrayList<>(List.of("id uuid PRIMARY KEY", "version bigint NOT NULL", "deleted boolean NOT NULL DEFAULT false",
                            "created_at timestamptz NOT NULL DEFAULT now()", "updated_at timestamptz NOT NULL DEFAULT now()"));
                    cols.addAll(columns(c.fields(), schema, table, fks, next));
                    ddl.add("CREATE TABLE " + table + " (" + String.join(", ", cols) + ")");
                    for (FieldMeta f : c.fields()) {
                        if (f.unique()) ddl.add(createUniqueIndex(name, table, f.name()));
                    }
                }
                case "createDocument" -> {
                    String name = step.path("name").asString();
                    var d = next.document(name).orElseThrow();
                    String table = Sql.documentTable(schema, name);
                    List<String> cols = new ArrayList<>(List.of("id uuid PRIMARY KEY", "version bigint NOT NULL", "number varchar(40) NOT NULL UNIQUE", "date date NOT NULL",
                            "status varchar(10) NOT NULL CHECK (status IN ('draft', 'posted', 'reversed'))", "deleted boolean NOT NULL DEFAULT false",
                            "created_at timestamptz NOT NULL DEFAULT now()", "updated_at timestamptz NOT NULL DEFAULT now()"));
                    cols.addAll(columns(d.fields(), schema, table, fks, next));
                    ddl.add("CREATE TABLE " + table + " (" + String.join(", ", cols) + ")");
                    ddl.add("CREATE SEQUENCE " + Sql.numberSequence(schema, name));
                }
                case "createRows" -> {
                    String doc = step.path("document").asString();
                    String rows = step.path("rows").asString();
                    RowsMeta r = next.document(doc).orElseThrow().rows().stream().filter(x -> x.name().equals(rows)).findFirst().orElseThrow();
                    String table = Sql.rowsTable(schema, doc, rows);
                    List<String> cols = new ArrayList<>(List.of("document_id uuid NOT NULL REFERENCES " + Sql.documentTable(schema, doc) + " (id) ON DELETE CASCADE", "line_no int NOT NULL"));
                    cols.addAll(columns(r.fields(), schema, table, fks, next));
                    cols.add("PRIMARY KEY (document_id, line_no)");
                    ddl.add("CREATE TABLE " + table + " (" + String.join(", ", cols) + ")");
                }
                case "createRegister" -> createRegister(ddl, fks, schema, next.register(step.path("name").asString()).orElseThrow(), next);
                case "addField" -> {
                    FieldMeta f = Json.convert(step.path("field"), FieldMeta.class);
                    String table = tableOf(schema, next, step);
                    String def = f.defaultValue() == null || f.defaultValue().isNull() ? "" : " DEFAULT " + literal(f);
                    ddl.add("ALTER TABLE " + table + " ADD COLUMN " + col(f.name()) + " " + Sql.type(f.type()) + def);
                    if (f.required()) {
                        // Fails, and rolls the deployment back, if existing records would be empty.
                        ddl.add("ALTER TABLE " + table + " ALTER COLUMN " + col(f.name()) + " SET NOT NULL");
                    }
                    if (f.type().isRef()) fks.add(new ForeignKey(table, f.name(), targetTable(schema, next, f)));
                    if (f.unique()) ddl.add(createUniqueIndex(step.path("object").asString(), table, f.name()));
                }
                case "changeField" -> {
                    FieldMeta from = Json.convert(step.path("from"), FieldMeta.class);
                    FieldMeta to = Json.convert(step.path("to"), FieldMeta.class);
                    String table = tableOf(schema, next, step);
                    if (!from.type().equals(to.type())) {
                        if (from.type().isRef() || to.type().isRef()) {
                            throw PlatformException.validation("Changing \"" + to.name() + "\" to or from a reference is not supported; add a new field instead.");
                        }
                        ddl.add("ALTER TABLE " + table + " ALTER COLUMN " + col(to.name()) + " TYPE " + Sql.type(to.type()) + " USING " + col(to.name()) + "::" + Sql.type(to.type()));
                    }
                    if (to.required() != from.required()) {
                        ddl.add("ALTER TABLE " + table + " ALTER COLUMN " + col(to.name()) + (to.required() ? " SET NOT NULL" : " DROP NOT NULL"));
                    }
                    String catalog = step.path("object").asString();
                    if (to.unique() && !from.unique()) ddl.add(createUniqueIndex(catalog, table, to.name()));
                    if (!to.unique() && from.unique()) ddl.add("DROP INDEX " + q(schema) + "." + q(uniqueIndexName(catalog, to.name())));
                }
                case "dropField" -> ddl.add("ALTER TABLE " + tableOf(schema, old, step) + " DROP COLUMN " + col(step.path("field").asString()));
                case "dropRows" -> ddl.add("DROP TABLE " + Sql.rowsTable(schema, step.path("document").asString(), step.path("rows").asString()));
                case "dropObject" -> {
                    String name = step.path("name").asString();
                    if (old.catalog(name).isPresent()) ddl.add("DROP TABLE " + Sql.catalogTable(schema, name) + " CASCADE");
                    old.document(name).ifPresent(d -> {
                        for (RowsMeta r : d.rows()) ddl.add("DROP TABLE " + Sql.rowsTable(schema, name, r.name()));
                        ddl.add("DROP TABLE " + Sql.documentTable(schema, name) + " CASCADE");
                        ddl.add("DROP SEQUENCE " + Sql.numberSequence(schema, name));
                    });
                    if (old.register(name).isPresent()) ddl.add("DROP TABLE " + Sql.registerTable(schema, name));
                }
                case "changeRegister" -> {
                    // Approved rebuild: movements are recreated by reposting documents.
                    String name = step.path("name").asString();
                    ddl.add("DROP TABLE " + Sql.registerTable(schema, name));
                    createRegister(ddl, fks, schema, next.register(name).orElseThrow(), next);
                }
                default -> throw PlatformException.validation("Unknown migration step " + op);
            }
        }
        for (ForeignKey fk : fks) {
            ddl.add("ALTER TABLE " + fk.table() + " ADD FOREIGN KEY (" + col(fk.column()) + ") REFERENCES " + fk.targetTable() + " (id)");
        }
        for (String s : ddl) {
            jdbc.execute(s);
        }
        return ddl;
    }

    private void createRegister(List<String> ddl, List<ForeignKey> fks, String schema, RegisterMeta r, Model model) {
        String table = Sql.registerTable(schema, r.name());
        List<String> cols = new ArrayList<>(List.of("id bigserial PRIMARY KEY", "period date NOT NULL", "recorder_type varchar(60) NOT NULL", "recorder_id uuid NOT NULL", "line_no int NOT NULL",
                "direction varchar(3) NOT NULL CHECK (direction IN ('in', 'out'))", "active boolean NOT NULL DEFAULT true", "created_at timestamptz NOT NULL DEFAULT now()"));
        for (FieldMeta d : r.dimensions()) {
            cols.add(col(d.name()) + " " + Sql.type(d.type()) + " NOT NULL");
            if (d.type().isRef()) fks.add(new ForeignKey(table, d.name(), targetTable(schema, model, d)));
        }
        for (FieldMeta m : r.values()) {
            cols.add(col(m.name()) + " " + Sql.type(m.type()) + " NOT NULL");
        }
        ddl.add("CREATE TABLE " + table + " (" + String.join(", ", cols) + ")");
        // One active movement per recorder line: a second posting of the same document cannot
        // add movements even if the status check were bypassed.
        ddl.add("CREATE UNIQUE INDEX " + q(indexName("r_" + r.name(), "recorder")) + " ON " + table + " (recorder_type, recorder_id, line_no) WHERE active");
        List<String> dims = r.dimensions().stream().map(d -> col(d.name())).toList();
        ddl.add("CREATE INDEX " + q(indexName("r_" + r.name(), "dims")) + " ON " + table + " (" + String.join(", ", dims) + ", period) WHERE active");
    }

    private List<String> columns(List<FieldMeta> fields, String schema, String table, List<ForeignKey> fks, Model model) {
        List<String> cols = new ArrayList<>();
        for (FieldMeta f : fields) {
            cols.add(col(f.name()) + " " + Sql.type(f.type()) + (f.required() ? " NOT NULL" : ""));
            if (f.type().isRef()) fks.add(new ForeignKey(table, f.name(), targetTable(schema, model, f)));
        }
        return cols;
    }

    private String targetTable(String schema, Model model, FieldMeta f) {
        String target = f.type().target();
        return Sql.objectTable(schema, model.kindOf(target).orElseThrow(), target);
    }

    private static String createUniqueIndex(String catalog, String table, String field) {
        return "CREATE UNIQUE INDEX " + q(uniqueIndexName(catalog, field)) + " ON " + table + " (" + col(field) + ") WHERE NOT deleted";
    }

    /** Same naming contract as Flyway V2. Both input names are ASCII and exclude '/'. */
    private static String uniqueIndexName(String catalog, String field) {
        return "ux_cf_" + DigestUtils.md5DigestAsHex((catalog + "/" + field).getBytes(StandardCharsets.US_ASCII));
    }

    private static String indexName(String prefix, String field) {
        String n = "ux_" + prefix + "_" + field;
        return n.length() <= 63 ? n : n.substring(0, 50) + "_" + Integer.toHexString(n.hashCode());
    }

    private static String tableOf(String schema, Model model, JsonNode step) {
        String object = step.path("object").asString();
        JsonNode rows = step.path("rows");
        if (!rows.isNull() && !rows.isMissingNode()) {
            return Sql.rowsTable(schema, object, rows.asString());
        }
        return Sql.objectTable(schema, model.kindOf(object).orElseThrow(), object);
    }

    /** A column default as SQL text; every case is validated, so nothing unescaped gets in. */
    private static String literal(FieldMeta f) {
        JsonNode d = f.defaultValue();
        String type = d.path("type").asString();
        JsonNode v = d.path("value");
        return switch (type) {
            case "integer" -> Long.toString(v.asLong());
            case "decimal" -> new BigDecimal(v.asString()).toPlainString();
            case "boolean" -> v.asBoolean() ? "true" : "false";
            case "string" -> "date".equals(f.type().kind()) ? "DATE '" + LocalDate.parse(v.asString()) + "'" : "'" + v.asString().replace("'", "''") + "'";
            default -> "NULL";
        };
    }
}
