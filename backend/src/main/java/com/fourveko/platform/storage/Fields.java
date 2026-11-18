package com.fourveko.platform.storage;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.FieldType;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Conversion and validation of field values between wire form and SQL. */
public final class Fields {
    private Fields() {}

    /** Placeholder with an explicit cast, so typed nulls and text values bind correctly. */
    public static String placeholder(FieldType t) {
        return switch (t.kind()) {
            case "decimal" -> "?::numeric";
            case "integer" -> "?::bigint";
            case "boolean" -> "?::boolean";
            case "date" -> "?::date";
            case "dateTime" -> "?::timestamptz";
            case "ref" -> "?::uuid";
            default -> "?::text";
        };
    }

    /** Why a wire value does not fit the field, or null when it does. Never rounds. */
    public static String problem(FieldMeta f, JsonNode v) {
        if (Wire.isNull(v)) {
            return f.required() ? "\"" + f.name() + "\" is required" : null;
        }
        FieldType t = f.type();
        String tag = Wire.tag(v);
        JsonNode p = Wire.payload(v);
        String bad = "\"" + f.name() + "\" must be " + t.describe();
        try {
            return switch (t.kind()) {
                case "string" -> {
                    if (!tag.equals("str")) yield bad;
                    String s = p.asString();
                    yield t.maxLength() != null && s.codePointCount(0, s.length()) > t.maxLength() ? "\"" + f.name() + "\" is longer than " + t.maxLength() + " characters" : null;
                }
                case "decimal" -> {
                    if (!tag.equals("dec") && !tag.equals("int")) yield bad;
                    BigDecimal d = new BigDecimal(p.asString());
                    BigDecimal n = d.stripTrailingZeros();
                    int scale = Math.max(n.scale(), 0);
                    int intDigits = n.precision() - n.scale();
                    if (scale > t.scale()) yield "\"" + f.name() + "\" has more than " + t.scale() + " decimal places";
                    if (intDigits > t.precision() - t.scale()) yield "\"" + f.name() + "\" has more than " + (t.precision() - t.scale()) + " digits before the decimal point";
                    yield null;
                }
                case "integer" -> tag.equals("int") ? null : bad;
                case "boolean" -> tag.equals("bool") ? null : bad;
                case "date" -> {
                    if (!tag.equals("date")) yield bad;
                    LocalDate.parse(p.asString());
                    yield null;
                }
                case "dateTime" -> {
                    if (!tag.equals("dateTime")) yield bad;
                    OffsetDateTime.parse(p.asString());
                    yield null;
                }
                case "ref" -> {
                    if (!tag.equals("ref") || !t.target().equals(p.path("type").asString())) yield bad;
                    UUID.fromString(p.path("id").asString());
                    yield null;
                }
                default -> "unknown type " + t.kind();
            };
        } catch (NumberFormatException | DateTimeParseException e) {
            return bad;
        } catch (IllegalArgumentException e) {
            return "\"" + f.name() + "\" refers to an invalid id";
        }
    }

    public static void check(String owner, FieldMeta f, JsonNode v) {
        String p = problem(f, v);
        if (p != null) throw PlatformException.validation(owner + ": " + p + ".");
    }

    /** SQL parameter for a validated wire value. */
    public static Object toSql(FieldMeta f, JsonNode v) {
        if (Wire.isNull(v)) return null;
        JsonNode p = Wire.payload(v);
        return switch (f.type().kind()) {
            case "decimal" -> new BigDecimal(p.asString());
            case "integer" -> p.asLong();
            case "boolean" -> p.asBoolean();
            case "ref" -> p.path("id").asString();
            default -> p.asString();
        };
    }

    /** Wire value of a column read from a result set. */
    public static JsonNode fromSql(FieldMeta f, ResultSet rs, String column) throws SQLException {
        Object raw = rs.getObject(column);
        if (raw == null) return Wire.nul();
        FieldType t = f.type();
        return switch (t.kind()) {
            case "string" -> Wire.str(rs.getString(column));
            case "decimal" -> Wire.dec(rs.getBigDecimal(column).setScale(t.scale()));
            case "integer" -> Wire.integer(rs.getLong(column));
            case "boolean" -> Wire.bool(rs.getBoolean(column));
            case "date" -> Wire.date(rs.getObject(column, LocalDate.class));
            case "dateTime" -> Wire.dateTime(rs.getObject(column, OffsetDateTime.class));
            case "ref" -> Wire.ref(t.targetKind(), t.target(), raw.toString());
            default -> Wire.nul();
        };
    }
}
