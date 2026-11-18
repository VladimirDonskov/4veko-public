package com.fourveko.platform.storage;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.metadata.Metadata.FieldType;
import java.util.regex.Pattern;

/**
 * Names and types of generated storage. Every identifier comes from validated metadata, is
 * checked again here and always quoted; values are always bound, never concatenated.
 */
public final class Sql {
    private static final Pattern NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]{0,55}");

    private Sql() {}

    static String checked(String name) {
        if (!NAME.matcher(name).matches()) {
            throw PlatformException.validation("\"" + name + "\" cannot be used as a storage name (letters, digits and _; at most 56 characters).");
        }
        return name;
    }

    public static String q(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    public static String schemaFor(String applicationId) {
        return "vks_" + applicationId.replace("-", "").substring(0, 16);
    }

    /** PostgreSQL truncates identifiers longer than 63 bytes; refuse instead of colliding. */
    private static String table(String schema, String name) {
        if (name.length() > 63) {
            throw PlatformException.validation("The storage name for \"" + name + "\" is longer than 63 characters; use shorter object or rows names.");
        }
        return q(schema) + "." + q(name);
    }

    public static String catalogTable(String schema, String name) {
        return table(schema, "c_" + checked(name));
    }

    public static String documentTable(String schema, String name) {
        return table(schema, "d_" + checked(name));
    }

    public static String rowsTable(String schema, String document, String rows) {
        return table(schema, "d_" + checked(document) + "__" + checked(rows));
    }

    public static String registerTable(String schema, String name) {
        return table(schema, "r_" + checked(name));
    }

    public static String numberSequence(String schema, String document) {
        return table(schema, "d_" + checked(document) + "_number");
    }

    public static String objectTable(String schema, String kind, String name) {
        return "catalog".equals(kind) ? catalogTable(schema, name) : documentTable(schema, name);
    }

    /** Column of a declared field. Quoted, case kept, prefixed so it never meets a system column. */
    public static String col(String field) {
        return q("f_" + checked(field));
    }

    public static String type(FieldType t) {
        return switch (t.kind()) {
            case "string" -> t.maxLength() == null ? "text" : "varchar(" + t.maxLength() + ")";
            case "decimal" -> "numeric(" + t.precision() + ", " + t.scale() + ")";
            case "integer" -> "bigint";
            case "boolean" -> "boolean";
            case "date" -> "date";
            case "dateTime" -> "timestamptz";
            case "ref" -> "uuid";
            default -> throw PlatformException.validation("Unknown field type " + t.kind());
        };
    }
}
