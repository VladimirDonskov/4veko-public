package com.fourveko.platform.app;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Json;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.security.Caller;
import com.fourveko.platform.storage.SchemaManager;
import com.fourveko.platform.storage.Sql;
import com.fourveko.platform.worker.ScriptSession;
import com.fourveko.platform.worker.WorkerPool;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Deployed VekoScript applications: checking, versioned deployment with migrations, lookup. */
@Service
public class ApplicationService {
    private static final Pattern APP_NAME = Pattern.compile("[a-z][a-z0-9-]{0,62}");

    /** A deployed version of an application, as scripts and storage see it. */
    public record App(String id, String organization, String name, String schema, int version, String source, Model metadata, Set<String> handlers) {
        public boolean hasHandler(String target, String event) {
            return handlers.contains(target + "." + event);
        }

        public String programKey() {
            return id + "/" + version;
        }
    }

    private final JdbcTemplate jdbc;
    private final WorkerPool pool;
    private final SchemaManager schemas;
    private final TransactionTemplate tx;
    private final Map<String, App> cache = new ConcurrentHashMap<>();

    public ApplicationService(JdbcTemplate jdbc, WorkerPool pool, SchemaManager schemas, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.pool = pool;
        this.schemas = schemas;
        this.tx = tx;
    }

    private JsonNode worker(String type, JsonNode payload) {
        try (ScriptSession s = pool.open()) {
            return s.request(type, payload, null);
        }
    }

    /** Diagnostics, metadata and handlers of a source, without deploying it. */
    public JsonNode check(String source) {
        ObjectNode p = Json.object();
        p.put("source", source);
        p.put("script", false);
        return worker("check", p);
    }

    private static boolean hasErrors(JsonNode diagnostics) {
        for (JsonNode d : diagnostics) {
            if ("error".equals(d.path("severity").asString())) return true;
        }
        return false;
    }

    private static String firstError(JsonNode diagnostics) {
        for (JsonNode d : diagnostics) {
            if ("error".equals(d.path("severity").asString())) {
                return d.path("line").asInt() + ":" + d.path("col").asInt() + " [" + d.path("code").asString() + "] " + d.path("message").asString();
            }
        }
        return "";
    }

    private void validateName(String name) {
        if (!APP_NAME.matcher(name).matches()) {
            throw PlatformException.badRequest("Application names are lowercase letters, digits and dashes, starting with a letter.");
        }
    }

    private void requireVersion(Integer expected, int current) {
        if (expected != null && expected != current) {
            throw new PlatformException(HttpStatus.CONFLICT, "VKS5013", "conflict",
                    "The active version is " + current + ". Review the latest source before publishing.");
        }
    }

    private JsonNode migration(String source, JsonNode previous) {
        ObjectNode request = Json.object();
        request.put("source", source);
        request.set("previous", previous);
        return worker("plan", request);
    }

    /** A read-only plan for the exact source and base revision the administrator is editing. */
    public ObjectNode preview(Caller caller, String name, String source, int expectedVersion) {
        caller.requireRole("admin");
        validateName(name);
        var rows = jdbc.queryForList("SELECT v.version, v.source, v.metadata::text AS metadata FROM vks_application a "
                + "JOIN vks_application_version v ON v.application_id = a.id AND v.version = a.current_version WHERE a.organization_id = ? AND a.name = ?", caller.organization(), name);
        int version = rows.isEmpty() ? 0 : ((Number) rows.getFirst().get("version")).intValue();
        requireVersion(expectedVersion, version);
        JsonNode result = migration(source, rows.isEmpty() ? null : Json.parse((String) rows.getFirst().get("metadata")));
        ObjectNode out = Json.object();
        out.put("version", version);
        out.put("unchanged", !rows.isEmpty() && source.equals(rows.getFirst().get("source")));
        out.set("diagnostics", result.path("diagnostics"));
        out.set("metadata", result.path("metadata"));
        out.set("plan", result.path("plan"));
        return out;
    }

    /**
     * Deploy a new version. Destructive storage changes need {@code approveDestructive}; without
     * it the plan is returned with 409 and nothing changes.
     */
    public ObjectNode deploy(Caller caller, String name, String source, boolean approveDestructive, Integer expectedVersion) {
        caller.requireRole("admin");
        validateName(name);
        JsonNode checked = check(source);
        JsonNode diagnostics = checked.path("diagnostics");
        if (hasErrors(diagnostics)) {
            ObjectNode details = Json.object();
            details.set("diagnostics", diagnostics);
            throw new PlatformException(HttpStatus.UNPROCESSABLE_CONTENT, "VKS5010", "semantic", "The application has errors: " + firstError(diagnostics), 0, 0, details);
        }
        return tx.execute(status -> {
            String candidateId = UUID.randomUUID().toString();
            jdbc.update("INSERT INTO vks_application (id, organization_id, name, schema_name) VALUES (?::uuid, ?, ?, ?) ON CONFLICT (organization_id, name) DO NOTHING",
                    candidateId, caller.organization(), name, Sql.schemaFor(candidateId));
            var existing = jdbc.queryForMap("SELECT id::text AS id, schema_name, COALESCE(current_version, 0) AS version FROM vks_application WHERE organization_id = ? AND name = ? FOR UPDATE",
                    caller.organization(), name);
            String id = (String) existing.get("id");
            String schema = (String) existing.get("schema_name");
            int current = ((Number) existing.get("version")).intValue();
            requireVersion(expectedVersion, current);
            JsonNode previous = null;
            if (current > 0) {
                Map<String, Object> v = jdbc.queryForMap("SELECT source, metadata::text AS metadata FROM vks_application_version WHERE application_id = ?::uuid AND version = ?", id, current);
                if (source.equals(v.get("source"))) {
                    ObjectNode same = Json.object();
                    same.put("application", name);
                    same.put("version", current);
                    same.put("unchanged", true);
                    return same;
                }
                previous = Json.parse((String) v.get("metadata"));
            }
            JsonNode planned = migration(source, previous);
            JsonNode plan = planned.path("plan");
            boolean destructive = false;
            for (JsonNode step : plan.path("steps")) {
                destructive |= step.path("requiresApproval").asBoolean();
            }
            if (destructive && !approveDestructive) {
                ObjectNode details = Json.object();
                details.set("plan", plan);
                throw new PlatformException(HttpStatus.CONFLICT, "VKS5005", "host", "This change can lose or invalidate data; review the plan and deploy again with approval.", 0, 0, details);
            }
            if (current == 0) schemas.createSchema(schema);
            Model oldModel = previous == null ? Model.empty() : Json.convert(previous, Model.class);
            Model newModel = Json.convert(planned.path("metadata"), Model.class);
            List<String> ddl = schemas.apply(schema, oldModel, newModel, plan.path("steps"));
            int version = current + 1;
            jdbc.update("INSERT INTO vks_application_version (application_id, version, source, metadata, handlers, plan, ddl, deployed_by) VALUES (?::uuid, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?)", id, version, source,
                    Json.write(planned.path("metadata")), Json.write(checked.path("handlers")), Json.write(plan), Json.write(ddl), caller.user());
            jdbc.update("UPDATE vks_application SET current_version = ? WHERE id = ?::uuid", version, id);
            ObjectNode detail = Json.object();
            detail.put("version", version);
            detail.put("steps", plan.path("steps").size());
            detail.put("approvedDestructive", destructive);
            jdbc.update("INSERT INTO vks_audit (organization_id, application_id, actor, action, detail) VALUES (?, ?::uuid, ?, 'deploy', ?::jsonb)", caller.organization(), id, caller.user(), Json.write(detail));
            ObjectNode out = Json.object();
            out.put("application", name);
            out.put("version", version);
            out.set("plan", plan);
            out.set("handlers", checked.path("handlers"));
            out.put("statements", ddl.size());
            return out;
        });
    }

    /** Applications of the caller's organization with their current version. */
    public List<Map<String, Object>> list(Caller caller) {
        return jdbc.queryForList("SELECT a.name, a.current_version AS version, v.deployed_at::text AS deployed_at, v.deployed_by FROM vks_application a "
                + "JOIN vks_application_version v ON v.application_id = a.id AND v.version = a.current_version WHERE a.organization_id = ? ORDER BY a.name", caller.organization());
    }

    /** The current version of an application of the caller's organization. */
    public App current(Caller caller, String name) {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT id::text AS id, current_version FROM vks_application WHERE organization_id = ? AND name = ?", caller.organization(), name);
        if (rows.isEmpty() || rows.getFirst().get("current_version") == null) {
            throw PlatformException.notFound("There is no application \"" + name + "\".");
        }
        return version((String) rows.getFirst().get("id"), ((Number) rows.getFirst().get("current_version")).intValue());
    }

    /** A specific version (used by after-commit events, which run on the version that raised them). */
    public App version(String id, int version) {
        return cache.computeIfAbsent(id + "/" + version, k -> {
            Map<String, Object> r = jdbc.queryForMap("SELECT a.organization_id, a.name, a.schema_name, v.source, v.metadata::text AS metadata, v.handlers::text AS handlers "
                    + "FROM vks_application a JOIN vks_application_version v ON v.application_id = a.id WHERE a.id = ?::uuid AND v.version = ?", id, version);
            Set<String> handlers = new HashSet<>();
            for (JsonNode h : Json.parse((String) r.get("handlers"))) {
                handlers.add(h.path("target").asString() + "." + h.path("event").asString());
            }
            Model model = Json.convert(Json.parse((String) r.get("metadata")), Model.class);
            return new App(id, (String) r.get("organization_id"), (String) r.get("name"), (String) r.get("schema_name"), version, (String) r.get("source"), model, Set.copyOf(handlers));
        });
    }
}
