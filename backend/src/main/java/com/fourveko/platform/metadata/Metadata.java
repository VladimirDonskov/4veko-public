package com.fourveko.platform.metadata;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Optional;
import tools.jackson.databind.JsonNode;

/** The metadata model as the engine produces it (see vks-metadata). Immutable. */
public final class Metadata {
    private Metadata() {}

    /** kind: string, decimal, integer, boolean, date, dateTime or ref. */
    public record FieldType(String kind, Integer maxLength, Integer precision, Integer scale, String target, String targetKind) {
        public boolean isRef() {
            return "ref".equals(kind);
        }

        public String describe() {
            return switch (kind) {
                case "string" -> maxLength == null ? "String" : "String(" + maxLength + ")";
                case "decimal" -> "Decimal(" + precision + ", " + scale + ")";
                case "integer" -> "Integer";
                case "boolean" -> "Boolean";
                case "date" -> "Date";
                case "dateTime" -> "DateTime";
                case "ref" -> "Ref<" + target + ">";
                default -> kind;
            };
        }
    }

    public record FieldMeta(String name, FieldType type, boolean required, boolean unique, @JsonProperty("default") JsonNode defaultValue) {}

    public record CatalogMeta(String name, List<FieldMeta> fields) {}

    public record RowsMeta(String name, List<FieldMeta> fields) {}

    public record DocumentMeta(String name, List<FieldMeta> fields, List<RowsMeta> rows) {}

    public record RegisterType(String kind, Boolean periodic) {}

    public record RegisterMeta(String name, RegisterType type, List<FieldMeta> dimensions, List<FieldMeta> values) {
        public boolean isAccumulation() {
            return "accumulation".equals(type.kind());
        }
    }

    public record Model(List<CatalogMeta> catalogs, List<DocumentMeta> documents, List<RegisterMeta> registers) {
        public static Model empty() {
            return new Model(List.of(), List.of(), List.of());
        }

        public Optional<CatalogMeta> catalog(String name) {
            return catalogs.stream().filter(c -> c.name().equals(name)).findFirst();
        }

        public Optional<DocumentMeta> document(String name) {
            return documents.stream().filter(d -> d.name().equals(name)).findFirst();
        }

        public Optional<RegisterMeta> register(String name) {
            return registers.stream().filter(r -> r.name().equals(name)).findFirst();
        }

        /** "catalog" or "document", if the name is one. */
        public Optional<String> kindOf(String name) {
            if (catalog(name).isPresent()) return Optional.of("catalog");
            if (document(name).isPresent()) return Optional.of("document");
            return Optional.empty();
        }

        public List<FieldMeta> fieldsOf(String name) {
            return catalog(name).map(CatalogMeta::fields).or(() -> document(name).map(DocumentMeta::fields)).orElse(List.of());
        }
    }
}
