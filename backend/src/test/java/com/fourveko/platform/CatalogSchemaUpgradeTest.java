package com.fourveko.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fourveko.platform.json.Json;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

class CatalogSchemaUpgradeTest extends PlatformTestBase {
    @Test
    void catalogUniquenessFollowsTheDeployedVersion() {
        String admin = token(org, "designer", "admin");
        String unique = "catalog Items { field code: String(20) unique; }";
        String ordinary = unique.replace(" unique", "");
        String path = "/api/v1/apps/stock/catalogs/Items";
        var item = obj("fields", obj("code", "DUP"));
        assertThat(deploy("stock", admin, unique, false).status()).isEqualTo(200);
        assertThat(POST(path, admin, item).status()).isEqualTo(201);
        assertThat(POST(path, admin, item).status()).isEqualTo(422);

        assertThat(deploy("stock", admin, ordinary, false).status()).isEqualTo(200);
        Response second = POST(path, admin, item);
        assertThat(second.status()).as(second.body().toString()).isEqualTo(201);
        assertThat(deploy("stock", admin, unique, false).status()).isEqualTo(409);
        assertThat(deploy("stock", admin, unique, true).status()).isEqualTo(409);
        assertThat(GET("/api/v1/apps/stock", admin).body().path("version").asInt()).isEqualTo(2);

        assertThat(DELETE(path + "/" + second.body().path("id").asString(), admin).status()).isEqualTo(204);
        assertThat(deploy("stock", admin, unique, true).status()).isEqualTo(200);
        assertThat(POST(path, admin, item).status()).isEqualTo(422);
        String withTag = unique.replace(" }", " field tag: String(10) unique; }");
        assertThat(deploy("stock", admin, withTag, true).status()).isEqualTo(200);
        String withoutTagConstraint = withTag.replace("String(10) unique", "String(10)");
        assertThat(deploy("stock", admin, withoutTagConstraint, false).status()).isEqualTo(200);
        assertThat(POST(path, admin, obj("fields", obj("code", "ONE", "tag", "same"))).status()).isEqualTo(201);
        assertThat(POST(path, admin, obj("fields", obj("code", "TWO", "tag", "same"))).status()).isEqualTo(201);
    }

    @Test
    void flywayUpgradesLegacyIndexesFromExistingMetadataAndDdlHistory() throws SQLException {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String control = "vks_mig_" + suffix;
        String data = "vks_data_" + suffix;
        String table = "\"" + data + "\".\"c_Items\"";
        try (var connection = jdbc.getDataSource().getConnection()) {
            var ds = new SingleConnectionDataSource(connection, true);
            var db = new JdbcTemplate(ds);
            try {
                Flyway.configure().dataSource(ds).schemas(control).target("1").load().migrate();
                db.execute("CREATE SCHEMA " + data);
                db.execute("CREATE TABLE " + table + " (deleted boolean DEFAULT false, f_code text, f_tag text, f_part text)");
                String codeIndex = "CREATE UNIQUE INDEX \"ux_c_Items_code\" ON " + table + " (\"f_code\") WHERE NOT deleted";
                String tagIndex = "CREATE UNIQUE INDEX \"ux_c_Itemstag_tag\" ON " + table + " (\"f_tag\") WHERE NOT deleted";
                String originalPartIndex = "CREATE UNIQUE INDEX \"ux_c_Items_part\" ON " + table + " (\"f_part\") WHERE NOT deleted";
                db.execute(codeIndex);
                db.execute(tagIndex);
                db.execute("CREATE UNIQUE INDEX \"ux_c_Items_part\" ON " + table + " (f_part) WHERE deleted");
                db.execute("CREATE INDEX unmanaged_tag ON " + table + " (f_tag)");
                UUID id = UUID.randomUUID();
                db.update("INSERT INTO " + control + ".vks_application (id, organization_id, name, schema_name, current_version) VALUES (?, 'test', 'stock', ?, 1)", id, data);
                var metadata = obj("catalogs", List.of(obj("name", "Items", "fields",
                        List.of(obj("name", "code", "unique", false), obj("name", "tag", "unique", true), obj("name", "part", "unique", true)))));
                db.update("INSERT INTO " + control + ".vks_application_version (application_id, version, source, metadata, handlers, plan, ddl, deployed_by) VALUES (?, 1, '', ?::jsonb, '[]', '{}', ?::jsonb, 'tester')",
                        id, Json.write(metadata), Json.write(List.of(codeIndex, tagIndex, originalPartIndex)));
                db.update("INSERT INTO " + table + " (f_code,f_tag,f_part) VALUES ('same','one','A'), ('other','two','A')");

                var upgrade = Flyway.configure().dataSource(ds).schemas(control).load();
                assertThatThrownBy(upgrade::migrate).isInstanceOf(FlywayException.class);
                assertThat(db.queryForList("SELECT indexname FROM pg_indexes WHERE schemaname = ? ORDER BY indexname", String.class, data))
                        .containsExactlyInAnyOrder("unmanaged_tag", "ux_c_Items_code", "ux_c_Itemstag_tag", "ux_c_Items_part");
                assertThat(db.queryForObject("SELECT count(*) FROM " + table + " WHERE f_part = 'A'", Integer.class)).isEqualTo(2);
                db.update("UPDATE " + table + " SET f_part = 'B' WHERE f_tag = 'two'");

                upgrade.migrate();
                db.update("INSERT INTO " + table + " (f_code,f_tag,f_part) VALUES ('same','three','C')");
                assertThat(db.queryForList("SELECT f_part FROM " + table + " ORDER BY f_part", String.class)).containsExactly("A", "B", "C");
                assertThat(db.queryForList("SELECT indexname FROM pg_indexes WHERE schemaname = ? ORDER BY indexname", String.class, data))
                        .containsExactlyInAnyOrder("unmanaged_tag", "ux_c_Items_part", db.queryForObject("SELECT 'ux_cf_' || md5('Items/tag')", String.class),
                                db.queryForObject("SELECT 'ux_cf_' || md5('Items/part')", String.class));
                assertThatThrownBy(() -> db.update("INSERT INTO " + table + " (f_tag) VALUES ('two')"))
                        .isInstanceOf(DuplicateKeyException.class);
            } finally {
                db.execute("DROP SCHEMA IF EXISTS " + data + " CASCADE");
                db.execute("DROP SCHEMA IF EXISTS " + control + " CASCADE");
            }
        }
    }
}
