package com.fourveko.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** What the configurator and generated forms rely on: application list, source, names, search. */
class ConfiguratorApiTest extends PlatformTestBase {
    private static final String APP = "/api/v1/apps/inventory";

    private final String admin = token(org, "ada.admin", "admin");
    private final String clerk = token(org, "carl.clerk", "clerk");

    @Test
    void applicationsSourceAndCallerInfo() {
        assertThat(GET("/api/v1/apps", admin).body().path("applications").size()).isZero();
        assertThat(deploy("inventory", admin, inventorySource(), false).status()).isEqualTo(200);

        JsonNode list = GET("/api/v1/apps", clerk).body();
        assertThat(list.path("applications").get(0).path("name").asString()).isEqualTo("inventory");
        assertThat(list.path("applications").get(0).path("version").asInt()).isEqualTo(1);
        assertThat(list.path("applications").get(0).path("deployedBy").asString()).isEqualTo("ada.admin");
        assertThat(list.path("you").path("capabilities").toString()).contains("document.post");

        Response source = GET(APP + "/source", admin);
        assertThat(source.status()).isEqualTo(200);
        assertThat(source.body().path("source").asString()).isEqualTo(inventorySource());
        assertThat(GET(APP + "/source", clerk).status()).isEqualTo(403);

        JsonNode described = GET(APP, clerk).body();
        assertThat(described.path("you").path("roles").get(0).asString()).isEqualTo("clerk");
        assertThat(described.path("metadata").path("documents").get(0).path("rows").get(0).path("name").asString()).isEqualTo("items");

        JsonNode checked = POST(APP + "/check", admin, obj("source", inventorySource())).body();
        assertThat(checked.path("ok").asBoolean()).isTrue();
        assertThat(checked.path("metadata").path("catalogs").size()).isEqualTo(3);
    }

    @Test
    void referencesCarryDisplayNamesAndListsSearch() {
        assertThat(deploy("inventory", admin, inventorySource(), false).status()).isEqualTo(200);
        String product = POST(APP + "/catalogs/Products", clerk, obj("fields", obj("code", "P-1001", "name", "Industrial Motor"))).body().path("id").asString();
        POST(APP + "/catalogs/Products", clerk, obj("fields", obj("code", "P-2002", "name", "Steel Bracket")));
        String warehouse = POST(APP + "/catalogs/Warehouses", clerk, obj("fields", obj("code", "MAIN", "name", "Main warehouse"))).body().path("id").asString();
        String supplier = POST(APP + "/catalogs/Suppliers", clerk, obj("fields", obj("code", "S-1", "name", "Acme Supply"))).body().path("id").asString();

        Response created = POST(APP + "/documents/GoodsReceipt", clerk, obj("date", "2026-10-15", "fields", obj("warehouse", warehouse, "supplier", supplier),
                "rows", obj("items", List.of(obj("product", product, "quantity", "2", "unitPrice", "3.00")))));
        assertThat(created.status()).as(created.body().toString()).isEqualTo(201);
        JsonNode receipt = created.body();
        assertThat(receipt.path("display").asString()).isEqualTo("GR-000001 · 2026-10-15");
        assertThat(receipt.path("fields").path("warehouse").path("display").asString()).isEqualTo("Main warehouse");
        assertThat(receipt.path("fields").path("supplier").path("display").asString()).isEqualTo("Acme Supply");
        assertThat(receipt.path("rows").path("items").get(0).path("product").path("display").asString()).isEqualTo("Industrial Motor");

        JsonNode found = GET(APP + "/catalogs/Products?q=bracket", clerk).body();
        assertThat(found.size()).isEqualTo(1);
        assertThat(found.get(0).path("display").asString()).isEqualTo("Steel Bracket");
        assertThat(GET(APP + "/catalogs/Products?q=P-10", clerk).body().size()).isEqualTo(1);
        assertThat(GET(APP + "/catalogs/Products?q=100%25", clerk).body().size()).isZero();
        assertThat(GET(APP + "/documents/GoodsReceipt?q=GR-0000", clerk).body().size()).isEqualTo(1);

        String id = receipt.path("id").asString();
        assertThat(POST(APP + "/documents/GoodsReceipt/" + id + "/post", clerk, null).status()).isEqualTo(200);
        JsonNode movement = GET(APP + "/registers/StockBalance/movements?recorder=" + id, clerk).body().get(0);
        assertThat(movement.path("dimensions").path("product").path("display").asString()).isEqualTo("Industrial Motor");
    }
}
