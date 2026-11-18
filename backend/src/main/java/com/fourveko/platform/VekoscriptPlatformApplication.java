package com.fourveko.platform;

import com.fourveko.platform.config.VksProperties;
import com.fourveko.platform.runtime.PlatformService;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(VksProperties.class)
public class VekoscriptPlatformApplication {

    public static void main(String[] args) {
        SpringApplication.run(VekoscriptPlatformApplication.class, args);
    }

    /** Retries after-commit events that could not be delivered right after their operation. */
    @Component
    static class OutboxPoller {
        private final PlatformService platform;

        OutboxPoller(PlatformService platform) {
            this.platform = platform;
        }

        @Scheduled(fixedDelayString = "${vks.outbox.poll-ms:5000}")
        void poll() {
            platform.dispatchOutbox();
        }
    }

    @RestController
    static class Health {
        @GetMapping("/health")
        String health() {
            return "{\"status\":\"ok\"}";
        }
    }
}
