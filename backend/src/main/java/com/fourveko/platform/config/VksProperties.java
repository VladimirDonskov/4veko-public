package com.fourveko.platform.config;

import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Settings under {@code vks.*}. */
@ConfigurationProperties("vks")
public record VksProperties(Worker worker, Security security, Limits limits) {

    public record Worker(String command, String engineDir, int poolSize, long timeoutMs, long acquireTimeoutMs, int maxMemoryMb) {}

    /**
     * Execution limits sent with every script run. Unset values use the engine's defaults
     * (see vks-protocol Limits). The worker timeout above is the outer wall-clock limit.
     */
    public record Limits(Long maxSteps, Long maxMillis, Integer maxCallDepth, Long maxCollectionLen, Long maxStringBytes, Long maxMemoryBytes, Integer maxHostCalls, Integer maxQueries, Integer maxEventDepth) {
        public static Limits none() {
            return new Limits(null, null, null, null, null, null, null, null, null);
        }
    }

    /**
     * HS256 secret (at least 32 bytes) for bearer tokens, and the capabilities each role grants.
     * Tokens carry {@code sub} (user), {@code org} (organization) and {@code roles}.
     */
    public record Security(String jwtSecret, Map<String, List<String>> roles) {}
}
