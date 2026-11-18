package com.fourveko.platform.worker;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.config.VksProperties;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/** A bounded pool of worker processes. Dead workers are discarded and replaced on demand. */
@Component
public class WorkerPool {
    private final VksProperties.Worker config;
    private final BlockingQueue<WorkerProcess> idle;
    private final Semaphore permits;
    private volatile List<String> command;

    public WorkerPool(VksProperties properties) {
        this.config = properties.worker();
        this.idle = new ArrayBlockingQueue<>(config.poolSize());
        this.permits = new Semaphore(config.poolSize());
    }

    private List<String> command() {
        if (command == null) {
            Path exe = resolveExecutable();
            List<String> c = new ArrayList<>();
            c.add(exe.toString());
            c.add("worker");
            c.add("--max-memory-mb");
            c.add(Integer.toString(config.maxMemoryMb()));
            command = List.copyOf(c);
        }
        return command;
    }

    private Path resolveExecutable() {
        String name = System.getProperty("os.name").toLowerCase().contains("win") ? "vks.exe" : "vks";
        List<Path> candidates = new ArrayList<>();
        if (config.command() != null && !config.command().isBlank()) {
            candidates.add(Path.of(config.command()));
        }
        String engineDir = System.getProperty("vks.engine.dir", config.engineDir());
        candidates.add(Path.of(engineDir, "target", "release", name));
        candidates.add(Path.of(engineDir, "target", "debug", name));
        for (Path p : candidates) {
            if (Files.isRegularFile(p)) return p.toAbsolutePath();
        }
        throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host",
                "The VekoScript worker binary was not found (looked at " + candidates + "). Build it with: cargo build --release -p vks-cli");
    }

    /** Borrow a worker for one operation. Close the session to return it. */
    public ScriptSession open() {
        try {
            if (!permits.tryAcquire(config.acquireTimeoutMs(), TimeUnit.MILLISECONDS)) {
                throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host", "All VekoScript workers are busy; try again.");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PlatformException(HttpStatus.SERVICE_UNAVAILABLE, "VKS5006", "host", "Interrupted while waiting for a worker.");
        }
        try {
            WorkerProcess w = idle.poll();
            while (w != null && w.isDead()) {
                w = idle.poll();
            }
            if (w == null) {
                w = new WorkerProcess(command());
            }
            return new ScriptSession(this, w, TimeUnit.MILLISECONDS.toNanos(config.timeoutMs()));
        } catch (RuntimeException e) {
            permits.release();
            throw e;
        }
    }

    void release(WorkerProcess w) {
        try {
            if (!w.isDead() && !idle.offer(w)) {
                w.close();
            }
        } finally {
            permits.release();
        }
    }

    @PreDestroy
    public void shutdown() {
        WorkerProcess w;
        while ((w = idle.poll()) != null) {
            w.close();
        }
    }
}
