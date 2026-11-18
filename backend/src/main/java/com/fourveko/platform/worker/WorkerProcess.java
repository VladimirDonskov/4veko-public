package com.fourveko.platform.worker;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Json;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;

/**
 * One isolated `vks worker` process. The platform writes one JSON message per line to its
 * stdin and reads one per line from its stdout. A reader thread queues lines so reads can time
 * out; a worker that misses its deadline is killed, never reused.
 */
public final class WorkerProcess implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(WorkerProcess.class);
    private static final String EOF = "\u0000eof";

    private final Process process;
    private final BufferedWriter input;
    private final BlockingQueue<String> lines = new LinkedBlockingQueue<>();
    private volatile boolean dead;

    public WorkerProcess(List<String> command) {
        try {
            process = new ProcessBuilder(command).redirectErrorStream(false).start();
        } catch (IOException e) {
            throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host", "Cannot start the VekoScript worker (" + String.join(" ", command) + "): " + e.getMessage());
        }
        input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        Thread.ofVirtual().name("vks-worker-out-" + process.pid()).start(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    lines.add(line);
                }
            } catch (IOException e) {
                log.debug("worker {} stdout closed: {}", process.pid(), e.getMessage());
            } finally {
                lines.add(EOF);
            }
        });
        Thread.ofVirtual().name("vks-worker-err-" + process.pid()).start(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    log.info("vks worker {}: {}", process.pid(), line);
                }
            } catch (IOException ignored) {
                // process ended
            }
        });
    }

    public long pid() {
        return process.pid();
    }

    public boolean isDead() {
        return dead || !process.isAlive();
    }

    public void send(JsonNode envelope) {
        try {
            input.write(Json.write(envelope));
            input.write('\n');
            input.flush();
        } catch (IOException e) {
            kill();
            throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host", "The VekoScript worker stopped: " + e.getMessage());
        }
    }

    /** Next message, waiting until the deadline (System.nanoTime based). */
    public JsonNode receive(long deadlineNanos) {
        String line;
        try {
            line = lines.poll(Math.max(0, deadlineNanos - System.nanoTime()), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            kill();
            throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host", "Interrupted while waiting for the VekoScript worker.");
        }
        if (line == null) {
            kill();
            throw new PlatformException(HttpStatus.GATEWAY_TIMEOUT, "VKS5008", "limit", "The script did not finish in time; its worker was stopped.");
        }
        if (EOF.equals(line)) {
            dead = true;
            throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host", "The VekoScript worker exited unexpectedly.");
        }
        return Json.parse(line);
    }

    public void kill() {
        dead = true;
        process.destroyForcibly();
    }

    @Override
    public void close() {
        if (!isDead()) {
            try {
                send(Protocol.envelope(0, "shutdown", null));
                if (!process.waitFor(2, TimeUnit.SECONDS)) {
                    kill();
                }
            } catch (RuntimeException | InterruptedException e) {
                kill();
            }
        }
    }
}
