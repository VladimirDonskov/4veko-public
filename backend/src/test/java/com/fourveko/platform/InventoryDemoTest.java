package com.fourveko.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * The required demonstration, end to end through the REST API, the Java platform, the Rust
 * worker and PostgreSQL: Products, Warehouses and Suppliers catalogs, a GoodsReceipt document
 * with lines, a StockBalance register and its posting handler.
 */
class InventoryDemoTest extends PlatformTestBase {
    private static final String APP = "/api/v1/apps/inventory";

    private final String admin = token(org, "ada.admin", "admin");
    private final String clerk = token(org, "carl.clerk", "clerk");
    private final String viewer = token(org, "vera.viewer", "viewer");

    private String create(String path, JsonNode body) {
        Response r = POST(APP + path, clerk, body);
        assertThat(r.status()).as(r.body().toString()).isEqualTo(201);
        return r.body().path("id").asString();
    }

    private int movementCount(String receiptId) {
        return GET(APP + "/registers/StockBalance/movements?recorder=" + receiptId, clerk).body().size();
    }

    @Test
    void seventeenSteps() {
        // 1. Register metadata: deploy the application (catalogs, document, register, logic).
        Response deployed = deploy("inventory", admin, inventorySource(), false);
        assertThat(deployed.status()).as(deployed.body().toString()).isEqualTo(200);
        assertThat(deployed.body().path("version").asInt()).isEqualTo(1);
        assertThat(deployed.body().path("handlers").toString()).contains("\"target\":\"GoodsReceipt\",\"event\":\"Post\"");

        // 2. Validate metadata: invalid metadata is refused with positioned diagnostics.
        Response invalid = deploy("broken", admin, "catalog Items {\n    field owner: Ref<Customers>;\n}\n", false);
        assertThat(invalid.status()).isEqualTo(422);
        JsonNode diag = invalid.body().path("diagnostics").get(0);
        assertThat(diag.path("code").asString()).isEqualTo("VKS2017");
        assertThat(diag.path("line").asInt()).isEqualTo(2);
        Response checked = POST(APP + "/check", admin, obj("source", "function f() { return missing; }"));
        assertThat(checked.body().path("ok").asBoolean()).isFalse();
        assertThat(checked.body().path("diagnostics").get(0).path("code").asString()).isEqualTo("VKS3001");

        // 3. Migrate: storage exists for every object; a compatible change migrates in place.
        String schema = schemaOf("inventory");
        List<String> tables = jdbc.queryForList("SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name", String.class, schema);
        assertThat(tables).containsExactly("c_Products", "c_Suppliers", "c_Warehouses", "d_GoodsReceipt", "d_GoodsReceipt__items", "r_StockBalance");
        Response v2 = deploy("inventory", admin, inventorySource().replace("field active: Boolean default true;", "field active: Boolean default true;\n    field barcode: String(30);"), false);
        assertThat(v2.status()).as(v2.body().toString()).isEqualTo(200);
        assertThat(v2.body().path("version").asInt()).isEqualTo(2);
        assertThat(v2.body().path("plan").path("steps").get(0).path("op").asString()).isEqualTo("addField");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_schema = ? AND table_name = 'c_Products' AND column_name = 'f_barcode'", Integer.class, schema)).isEqualTo(1);

        // 4. Create catalog records.
        String product = create("/catalogs/Products", obj("fields", obj("code", "P-1001", "name", "Industrial Motor", "price", "1250.00")));
        String warehouse = create("/catalogs/Warehouses", obj("fields", obj("code", "MAIN", "name", "Main warehouse")));
        String supplier = create("/catalogs/Suppliers", obj("fields", obj("code", "S-1", "name", "Acme Supply")));
        JsonNode p = GET(APP + "/catalogs/Products/" + product, viewer).body();
        assertThat(p.path("fields").path("unit").asString()).isEqualTo("ea");
        assertThat(p.path("fields").path("paymentTermsDays").isMissingNode()).isTrue();
        Response duplicate = POST(APP + "/catalogs/Products", clerk, obj("fields", obj("code", "P-1001", "name", "Copy")));
        assertThat(duplicate.status()).isEqualTo(422);
        assertThat(duplicate.body().path("detail").asString()).contains("already has code P-1001");

        // 5. Create a document.
        Response created = POST(APP + "/documents/GoodsReceipt", clerk, obj("date", "2026-10-15", "fields", obj("warehouse", warehouse, "supplier", supplier, "supplierInvoice", "INV-77")));
        assertThat(created.status()).as(created.body().toString()).isEqualTo(201);
        String receipt = created.body().path("id").asString();
        assertThat(created.body().path("number").asString()).isEqualTo("GR-000001");
        assertThat(created.body().path("status").asString()).isEqualTo("draft");

        // 6. Add lines; BeforeSave computes line amounts and the total.
        Response lines = PUT(APP + "/documents/GoodsReceipt/" + receipt, clerk, obj("version", created.body().path("version").asLong(), "rows", obj("items", List.of(
                obj("product", product, "quantity", "10", "unitPrice", "250.00"),
                obj("product", product, "quantity", "2.5", "unitPrice", "100.00")))));
        assertThat(lines.status()).as(lines.body().toString()).isEqualTo(200);
        assertThat(lines.body().path("fields").path("total").asString()).isEqualTo("2750.00");
        assertThat(lines.body().path("rows").path("items").get(1).path("amount").asString()).isEqualTo("250.00");
        assertThat(lines.body().path("rows").path("items").get(1).path("lineNo").asInt()).isEqualTo(2);
        long version = lines.body().path("version").asLong();

        // 7. Validate: the handler rejects a bad line; nothing changes.
        Response rejected = PUT(APP + "/documents/GoodsReceipt/" + receipt, clerk, obj("version", version, "rows", obj("items", List.of(obj("product", product, "quantity", "0", "unitPrice", "1.00")))));
        assertThat(rejected.status()).isEqualTo(422);
        assertThat(rejected.body().path("kind").asString()).isEqualTo("rejected");
        assertThat(rejected.body().path("detail").asString()).isEqualTo("Quantity must be greater than zero for P-1001.");
        assertThat(GET(APP + "/documents/GoodsReceipt/" + receipt, clerk).body().path("version").asLong()).isEqualTo(version);
        Response tooPrecise = PUT(APP + "/documents/GoodsReceipt/" + receipt, clerk, obj("version", version, "rows", obj("items", List.of(obj("product", product, "quantity", "1.0001", "unitPrice", "1.00")))));
        assertThat(tooPrecise.status()).isEqualTo(422);
        assertThat(tooPrecise.body().path("detail").asString()).contains("quantity").contains("3 decimal places");

        // 8. Post.
        Response posted = POST(APP + "/documents/GoodsReceipt/" + receipt + "/post", clerk, null);
        assertThat(posted.status()).as(posted.body().toString()).isEqualTo(200);
        assertThat(posted.body().path("status").asString()).isEqualTo("posted");

        // 9. Movements were generated by the Post handler, one per line.
        JsonNode movements = GET(APP + "/registers/StockBalance/movements?recorder=" + receipt, clerk).body();
        assertThat(movements.size()).isEqualTo(2);
        assertThat(movements.get(0).path("direction").asString()).isEqualTo("in");
        assertThat(movements.get(0).path("period").asString()).isEqualTo("2026-10-15");
        assertThat(movements.get(0).path("measures").path("quantity").asString()).isEqualTo("10.000");
        assertThat(movements.get(1).path("dimensions").path("warehouse").path("id").asString()).isEqualTo(warehouse);

        // 10. Persisted atomically with the status, the audit record and the after-commit event.
        assertThat(jdbc.queryForObject("SELECT detail->>'movements' FROM vks_audit WHERE organization_id = ? AND action = 'post' AND object_id = ?::uuid", String.class, org, receipt)).isEqualTo("2");
        assertThat(jdbc.queryForList("SELECT message FROM vks_notification WHERE organization_id = ?", String.class, org)).containsExactly("Received 2 line(s) into Main warehouse.");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM vks_outbox WHERE organization_id = ? AND processed_at IS NULL", Integer.class, org)).isZero();

        // 11. Current balance.
        String query = APP + "/registers/StockBalance/balance?product=" + product + "&warehouse=" + warehouse;
        JsonNode balance = GET(query, viewer).body();
        assertThat(balance.path("quantity").asString()).isEqualTo("12.500");
        assertThat(balance.path("amount").asString()).isEqualTo("2750.00");

        // 12. Historical balances.
        assertThat(GET(query + "&at=2026-10-14", viewer).body().path("quantity").asString()).isEqualTo("0.000");
        assertThat(GET(query + "&at=2026-10-15", viewer).body().path("quantity").asString()).isEqualTo("12.500");

        // 13. Reverse.
        Response reversed = POST(APP + "/documents/GoodsReceipt/" + receipt + "/reverse", clerk, null);
        assertThat(reversed.status()).as(reversed.body().toString()).isEqualTo(200);
        assertThat(reversed.body().path("status").asString()).isEqualTo("reversed");
        JsonNode after = GET(APP + "/registers/StockBalance/movements?recorder=" + receipt, clerk).body();
        assertThat(after.findValues("active").stream().map(JsonNode::asBoolean)).containsOnly(false);

        // 14. Recalculate: balances follow the reversal, and a repost restores them.
        assertThat(GET(query, viewer).body().path("quantity").asString()).isEqualTo("0.000");
        assertThat(POST(APP + "/documents/GoodsReceipt/" + receipt + "/post", clerk, null).status()).isEqualTo(200);
        assertThat(GET(query, viewer).body().path("quantity").asString()).isEqualTo("12.500");
        assertThat(movementCount(receipt)).isEqualTo(4);

        // 15. Unauthorized operations are rejected.
        assertThat(POST(APP + "/documents/GoodsReceipt/" + receipt + "/reverse", viewer, null).status()).isEqualTo(403);
        assertThat(POST(APP + "/catalogs/Products", viewer, obj("fields", obj("code", "X", "name", "X"))).status()).isEqualTo(403);
        assertThat(deploy("inventory", clerk, inventorySource(), false).status()).isEqualTo(403);
        assertThat(GET(query, null).status()).isEqualTo(401);
        assertThat(GET(query, token("org-other", "eve", "admin")).status()).isEqualTo(404);

        // 16. Duplicate posting is refused and changes nothing.
        Response again = POST(APP + "/documents/GoodsReceipt/" + receipt + "/post", clerk, null);
        assertThat(again.status()).isEqualTo(409);
        assertThat(again.body().path("detail").asString()).contains("already posted");
        assertThat(movementCount(receipt)).isEqualTo(4);

        // 17. A storage failure while writing movements rolls the whole posting back.
        String second = create("/documents/GoodsReceipt", obj("fields", obj("warehouse", warehouse, "supplier", supplier), "rows", obj("items", List.of(
                obj("product", product, "quantity", "3", "unitPrice", "1.00"),
                obj("product", product, "quantity", "7", "unitPrice", "1.00")))));
        jdbc.execute("CREATE FUNCTION \"" + schema + "\".fail_on_seven() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.\"f_quantity\" = 7 THEN RAISE EXCEPTION 'simulated disk failure'; END IF; RETURN NEW; END $$");
        jdbc.execute("CREATE TRIGGER fail_on_seven BEFORE INSERT ON \"" + schema + "\".\"r_StockBalance\" FOR EACH ROW EXECUTE FUNCTION \"" + schema + "\".fail_on_seven()");
        Response failed = POST(APP + "/documents/GoodsReceipt/" + second + "/post", clerk, null);
        assertThat(failed.status()).isEqualTo(500);
        assertThat(failed.body().path("detail").asString()).isEqualTo("Storage failed; nothing was changed.");
        assertThat(GET(APP + "/documents/GoodsReceipt/" + second, clerk).body().path("status").asString()).isEqualTo("draft");
        assertThat(movementCount(second)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM vks_audit WHERE action = 'post' AND object_id = ?::uuid", Integer.class, second)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM vks_outbox WHERE event = 'AfterPost' AND object_id = ?::uuid", Integer.class, second)).isZero();
        jdbc.execute("DROP TRIGGER fail_on_seven ON \"" + schema + "\".\"r_StockBalance\"");
        assertThat(POST(APP + "/documents/GoodsReceipt/" + second + "/post", clerk, null).status()).isEqualTo(200);
        assertThat(GET(query, viewer).body().path("quantity").asString()).isEqualTo("22.500");
    }

    @Test
    void concurrentPostingsOfOneDocumentPostItOnce() throws Exception {
        assertThat(deploy("inventory", admin, inventorySource(), false).status()).isEqualTo(200);
        String product = create("/catalogs/Products", obj("fields", obj("code", "P-1", "name", "Motor")));
        String warehouse = create("/catalogs/Warehouses", obj("fields", obj("code", "W", "name", "Main")));
        String supplier = create("/catalogs/Suppliers", obj("fields", obj("code", "S", "name", "Acme")));
        String receipt = create("/documents/GoodsReceipt", obj("fields", obj("warehouse", warehouse, "supplier", supplier), "rows", obj("items", List.of(obj("product", product, "quantity", "1", "unitPrice", "1.00")))));

        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<Callable<Integer>> tasks = new ArrayList<>();
            for (int i = 0; i < 4; i++) tasks.add(() -> POST(APP + "/documents/GoodsReceipt/" + receipt + "/post", clerk, null).status());
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> f : pool.invokeAll(tasks)) statuses.add(f.get());
            assertThat(statuses).containsOnlyOnce(200);
            assertThat(statuses.stream().filter(s -> s == 409).count()).isEqualTo(3);
        } finally {
            pool.shutdown();
        }
        assertThat(movementCount(receipt)).isEqualTo(1);
    }

    @Test
    void scriptsActWithTheCallersPermissions() {
        String source = inventorySource() + """

                function addProduct(code) {
                    let p = Catalog.Products.create(code: code, name: "From a script");
                    p.save();
                    return p.id;
                }
                """;
        assertThat(deploy("inventory", admin, source, false).status()).isEqualTo(200);
        Response byClerk = POST(APP + "/functions/addProduct", clerk, obj("args", List.of("P-77")));
        assertThat(byClerk.status()).as(byClerk.body().toString()).isEqualTo(200);
        assertThat(byClerk.body().path("value").asString()).hasSize(36);
        Response byViewer = POST(APP + "/functions/addProduct", viewer, obj("args", List.of("P-78")));
        assertThat(byViewer.status()).isEqualTo(403);
        assertThat(byViewer.body().path("code").asString()).isEqualTo("VKS4300");
        assertThat(byViewer.body().path("line").asInt()).isEqualTo(source.substring(0, source.indexOf("p.save()")).split("\n", -1).length);
    }

    @Test
    void destructiveMigrationsNeedApproval() {
        assertThat(deploy("inventory", admin, inventorySource(), false).status()).isEqualTo(200);
        create("/catalogs/Products", obj("fields", obj("code", "P-1", "name", "Motor", "unit", "box")));
        String narrowed = inventorySource().replace("    field unit: String(10) default \"ea\";\n", "").replace("    field unit: String(10) default \"ea\";\r\n", "");
        Response refused = deploy("inventory", admin, narrowed, false);
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.body().path("code").asString()).isEqualTo("VKS5005");
        assertThat(refused.body().path("plan").path("steps").get(0).path("reason").asString()).contains("unit");
        String schema = schemaOf("inventory");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_schema = ? AND table_name = 'c_Products' AND column_name = 'f_unit'", Integer.class, schema)).isEqualTo(1);
        Response approved = deploy("inventory", admin, narrowed, true);
        assertThat(approved.status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_schema = ? AND table_name = 'c_Products' AND column_name = 'f_unit'", Integer.class, schema)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM vks_audit WHERE organization_id = ? AND action = 'deploy' AND detail->>'approvedDestructive' = 'true'", Integer.class, org)).isEqualTo(1);
    }
}
