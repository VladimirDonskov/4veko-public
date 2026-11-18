package com.fourveko.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;

class StudioApiTest extends PlatformTestBase {
    private static final String APP = "/api/v1/apps/stock";
    private static final String SOURCE = "catalog Items { field code: String(10); field note: String(30); }";
    private final String admin = token(org, "designer", "admin");

    @Test
    void reviewIsReadOnlyAndDestructivePublicationNeedsApproval() {
        var body = obj("source", SOURCE, "expectedVersion", 0);
        var invalid = POST(APP + "/preview", admin, obj("source", "function broken( {", "expectedVersion", 0));
        assertThat(invalid.body().path("diagnostics").get(0).path("line").asInt()).isPositive();
        assertThat(invalid.body().path("plan").isNull()).isTrue();
        var planned = POST(APP + "/preview", admin, body);
        assertThat(planned.status()).isEqualTo(200);
        assertThat(planned.body().path("plan").path("steps").get(0).path("op").asString()).isEqualTo("createCatalog");
        assertThat(GET(APP, admin).status()).isEqualTo(404);
        assertThat(POST(APP + "/preview", admin, obj("source", SOURCE, "expectedVersion", "0")).status()).isEqualTo(400);
        assertThat(POST(APP + "/preview", token(org, "viewer", "viewer"), body).status()).isEqualTo(403);
        assertThat(PUT(APP, admin, body).status()).isEqualTo(200);
        var smaller = obj("source", SOURCE.replace(" field note: String(30);", ""), "expectedVersion", 1);
        assertThat(POST(APP + "/preview", admin, smaller).body().path("plan").path("steps").get(0).path("requiresApproval").asBoolean()).isTrue();
        assertThat(POST(APP + "/preview", admin, body).body().path("code").asString()).isEqualTo("VKS5013");
        assertThat(PUT(APP, admin, smaller).status()).isEqualTo(409);
        assertThat(GET(APP + "/source", admin).body().path("source").asString()).isEqualTo(SOURCE);
        smaller.put("approveDestructive", true);
        assertThat(PUT(APP, admin, smaller).body().path("version").asInt()).isEqualTo(2);
        String other = token("other-" + org, "designer", "admin");
        assertThat(POST(APP + "/preview", other, body).body().path("version").asInt()).isZero();
        assertThat(GET(APP + "/source", other).status()).isEqualTo(404);
    }

    @Test
    void racingEditorsPublishOnlyOneSourceForEachBaseRevision() throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            for (int version = 0; version < 2; version++) {
                int base = version;
                List<Callable<Response>> attempts = List.of(
                        () -> PUT(APP, admin, obj("source", SOURCE + "// Ada " + base, "expectedVersion", base)),
                        () -> PUT(APP, admin, obj("source", SOURCE + "// Lee " + base, "expectedVersion", base)));
                var futures = pool.invokeAll(attempts);
                var left = futures.get(0).get();
                var right = futures.get(1).get();
                assertThat(List.of(left.status(), right.status())).containsExactlyInAnyOrder(200, 409);
                assertThat((left.status() == 409 ? left : right).body().path("code").asString()).isEqualTo("VKS5013");
                assertThat(GET(APP + "/source", admin).body().path("version").asInt()).isEqualTo(base + 1);
            }
        }
    }
}
