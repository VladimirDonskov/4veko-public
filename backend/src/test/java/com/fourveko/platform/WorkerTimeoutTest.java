package com.fourveko.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

/**
 * The platform's wall-clock limit is the last line of defense: a worker that does not answer in
 * time is killed, the operation fails cleanly, and the next operation gets a fresh worker.
 */
@TestPropertySource(properties = {"vks.worker.timeout-ms=1500", "vks.limits.max-steps=100000000000", "vks.limits.max-millis=600000"})
class WorkerTimeoutTest extends PlatformTestBase {

    @Test
    void aStuckWorkerIsKilledAndReplaced() {
        String admin = token(org, "ada", "admin");
        String source = inventorySource() + """

                function spin() {
                    let n = 0;
                    while true { n += 1; }
                }
                function answer() { return 42; }
                """;
        assertThat(deploy("inventory", admin, source, false).status()).isEqualTo(200);

        long started = System.nanoTime();
        Response stuck = POST("/api/v1/apps/inventory/functions/spin", admin, obj("args", List.of()));
        long millis = (System.nanoTime() - started) / 1_000_000;
        assertThat(stuck.status()).isEqualTo(504);
        assertThat(stuck.body().path("code").asString()).isEqualTo("VKS5008");
        assertThat(millis).isBetween(1_400L, 4_000L);

        Response next = POST("/api/v1/apps/inventory/functions/answer", admin, obj("args", List.of()));
        assertThat(next.status()).isEqualTo(200);
        assertThat(next.body().path("value").asLong()).isEqualTo(42);
    }
}
