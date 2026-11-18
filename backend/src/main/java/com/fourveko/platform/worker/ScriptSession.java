package com.fourveko.platform.worker;

import com.fourveko.platform.PlatformException;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A worker lent to one business operation. Requests may nest: while a script waits for a host
 * call, the platform can start another execution (an event handler) on the same worker; the
 * worker answers the newest request first, so reading in order is correct.
 */
public final class ScriptSession implements AutoCloseable {
    /** Answers the worker's host calls; may call {@link #request} again (nesting). */
    @FunctionalInterface
    public interface HostHandler {
        /** Returns the hostResult payload. */
        ObjectNode handle(JsonNode hostCall);
    }

    private final WorkerPool pool;
    private final WorkerProcess worker;
    private final long timeoutNanos;
    private long nextId = 1;
    private int depth;
    private long deadline;

    ScriptSession(WorkerPool pool, WorkerProcess worker, long timeoutNanos) {
        this.pool = pool;
        this.worker = worker;
        this.timeoutNanos = timeoutNanos;
    }

    /** Send a request and return the payload of its result, answering host calls meanwhile. */
    public JsonNode request(String type, JsonNode payload, HostHandler host) {
        if (depth == 0) {
            deadline = System.nanoTime() + timeoutNanos;
        }
        depth++;
        try {
            long id = nextId++;
            worker.send(Protocol.envelope(id, type, payload));
            while (true) {
                JsonNode env = worker.receive(deadline);
                if (!Protocol.VERSION.equals(env.path("protocol").asString(""))) {
                    throw protocolError("unexpected protocol " + env.path("protocol"));
                }
                String t = env.path("type").asString("");
                long rid = env.path("id").asLong();
                JsonNode p = env.path("payload");
                switch (t) {
                    case "hostCall" -> {
                        if (host == null) throw protocolError("host call during " + type);
                        ObjectNode result = host.handle(p);
                        worker.send(Protocol.envelope(rid, "hostResult", result));
                    }
                    case "protocolError" -> throw protocolError(p.path("message").asString());
                    default -> {
                        if (rid != id) throw protocolError("answer " + rid + " to request " + id);
                        return p;
                    }
                }
            }
        } catch (RuntimeException e) {
            // Business failures come back as results, not exceptions; anything thrown here
            // leaves the worker mid-conversation, so it is never reused.
            worker.kill();
            throw e;
        } finally {
            depth--;
        }
    }

    private PlatformException protocolError(String message) {
        worker.kill();
        return new PlatformException(HttpStatus.BAD_GATEWAY, "VKS5009", "host", "VekoScript worker protocol error: " + message);
    }

    @Override
    public void close() {
        pool.release(worker);
    }
}
