package com.fourveko.platform.runtime;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.app.ApplicationService;
import com.fourveko.platform.app.ApplicationService.App;
import com.fourveko.platform.config.VksProperties;
import com.fourveko.platform.json.Json;
import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.DocumentMeta;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.metadata.Metadata.RegisterMeta;
import com.fourveko.platform.metadata.Metadata.RowsMeta;
import com.fourveko.platform.security.Caller;
import com.fourveko.platform.storage.Fields;
import com.fourveko.platform.storage.ObjectStore;
import com.fourveko.platform.storage.Presentations;
import com.fourveko.platform.storage.RegisterStore;
import com.fourveko.platform.worker.ScriptSession;
import com.fourveko.platform.worker.WorkerPool;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Business operations of VekoScript applications. Each operation is one database transaction
 * and borrows at most one worker. Scripts never touch the database: their host calls come back
 * here, are authorized against the caller's capabilities and run in the same transaction. A
 * failure anywhere, including inside a script or a nested handler, rolls the whole operation
 * back.
 */
@Service
public class PlatformService {
    private static final Logger log = LoggerFactory.getLogger(PlatformService.class);
    private static final int MAX_OUTBOX_ATTEMPTS = 5;

    private final ApplicationService apps;
    private final ObjectStore objects;
    private final RegisterStore registers;
    private final WorkerPool pool;
    private final TransactionTemplate tx;
    private final JdbcTemplate jdbc;
    private final VksProperties.Limits limits;
    private final Presentations presentations;

    public PlatformService(ApplicationService apps, ObjectStore objects, RegisterStore registers, WorkerPool pool, TransactionTemplate tx, JdbcTemplate jdbc, VksProperties properties,
            Presentations presentations) {
        this.presentations = presentations;
        this.apps = apps;
        this.objects = objects;
        this.registers = registers;
        this.pool = pool;
        this.tx = tx;
        this.jdbc = jdbc;
        this.limits = properties.limits() == null ? VksProperties.Limits.none() : properties.limits();
    }

    /** State of one operation: application version, caller, clock and the borrowed worker. */
    public final class Op implements AutoCloseable {
        final App app;
        final Caller caller;
        final String now = Wire.formatDateTime(OffsetDateTime.now(ZoneOffset.UTC));
        final String correlationId = UUID.randomUUID().toString();
        private ScriptSession session;

        Op(App app, Caller caller) {
            this.app = app;
            this.caller = caller;
        }

        Model model() {
            return app.metadata();
        }

        String schema() {
            return app.schema();
        }

        ScriptSession session() {
            if (session == null) session = pool.open();
            return session;
        }

        LocalDate today() {
            return LocalDate.parse(now.substring(0, 10));
        }

        @Override
        public void close() {
            if (session != null) session.close();
        }
    }

    /** Run {@code body} as one transactional operation, then deliver after-commit events. */
    public <T> T run(Caller caller, String application, Function<Op, T> body) {
        App app = apps.current(caller, application);
        T result;
        try (Op op = new Op(app, caller)) {
            result = tx.execute(status -> body.apply(op));
        }
        dispatchOutbox();
        return result;
    }

    // ----- scripts -----------------------------------------------------------------------

    private ObjectNode context(Op op, int depth, String operation) {
        ObjectNode c = Json.object();
        c.put("organization", op.caller.organization());
        c.put("user", op.caller.user());
        c.put("application", op.app.name());
        c.put("scriptVersion", op.app.version());
        ArrayNode caps = c.putArray("capabilities");
        op.caller.capabilities().forEach(caps::add);
        c.put("operation", operation);
        c.put("now", op.now);
        c.put("correlationId", op.correlationId);
        c.put("eventDepth", depth);
        // Only the limits configured here; the engine fills in the rest.
        ObjectNode limits = (ObjectNode) Json.tree(this.limits);
        limits.properties().removeIf(e -> e.getValue().isNull());
        c.set("limits", limits);
        return c;
    }

    private ObjectNode execute(Op op, ObjectNode entry, int depth, String operation) {
        ObjectNode payload = Json.object();
        ObjectNode program = payload.putObject("program");
        program.put("key", op.app.programKey());
        program.put("source", op.app.source());
        payload.set("context", context(op, depth, operation));
        payload.set("entry", entry);
        JsonNode result = op.session().request("execute", payload, call -> hostCall(op, call, depth));
        return (ObjectNode) result;
    }

    /** Turn a script failure into the matching API error. */
    static PlatformException scriptError(JsonNode e) {
        String code = e.path("code").asString();
        String kind = e.path("kind").asString();
        HttpStatus status = switch (kind) {
            case "permission" -> HttpStatus.FORBIDDEN;
            case "syntax", "semantic", "metadata" -> HttpStatus.INTERNAL_SERVER_ERROR;
            case "host" -> switch (code) {
                case "VKS4401" -> HttpStatus.NOT_FOUND;
                case "VKS4403" -> HttpStatus.CONFLICT;
                case "VKS4404" -> HttpStatus.NOT_IMPLEMENTED;
                case "VKS4400" -> HttpStatus.INTERNAL_SERVER_ERROR;
                default -> HttpStatus.UNPROCESSABLE_CONTENT;
            };
            default -> HttpStatus.UNPROCESSABLE_CONTENT;
        };
        return new PlatformException(status, code, kind, e.path("message").asString(), e.path("line").asInt(), e.path("col").asInt(), null);
    }

    /** Run an event handler if the application has one. Returns its result, or null. */
    private ObjectNode handler(Op op, String target, String event, ObjectNode object, int depth) {
        if (!op.app.hasHandler(target, event)) return null;
        ObjectNode entry = Json.object();
        entry.put("kind", "handler");
        entry.put("target", target);
        entry.put("event", event);
        entry.set("object", object);
        ObjectNode r = execute(op, entry, depth, target + "." + event);
        if (!r.path("ok").asBoolean()) throw scriptError(r.path("error"));
        return r;
    }

    /** Answer a worker's host call. Failures go back to the script as host errors. */
    private ObjectNode hostCall(Op op, JsonNode call, int depth) {
        try {
            String type = call.path("type").asString();
            String kind = call.path("kind").asString();
            JsonNode ok = switch (call.path("op").asString()) {
                case "findById" -> {
                    op.caller.require(kind + ".read");
                    ObjectNode o = objects.find(op.schema(), op.model(), type, call.path("id").asString(), false);
                    yield o == null ? Wire.nul() : Wire.object(o);
                }
                case "findBy" -> {
                    op.caller.require(kind + ".read");
                    ObjectNode o = objects.findBy(op.schema(), op.model(), type, call.path("field").asString(), call.path("value"));
                    yield o == null ? Wire.nul() : Wire.object(o);
                }
                case "list" -> {
                    op.caller.require(kind + ".read");
                    Map<String, JsonNode> filter = new HashMap<>();
                    for (var e : call.path("filter").properties()) filter.put(e.getKey(), e.getValue());
                    ObjectNode a = Json.object();
                    a.put("t", "array");
                    ArrayNode items = a.putArray("v");
                    for (ObjectNode o : objects.list(op.schema(), op.model(), type, filter, call.path("limit").asInt(100), call.path("offset").asInt(0))) {
                        items.add(Wire.object(o));
                    }
                    yield a;
                }
                case "save" -> Wire.object(save(op, (ObjectNode) call.path("object"), depth + 1));
                case "delete" -> {
                    delete(op, type, call.path("id").asString(), depth + 1);
                    yield Wire.nul();
                }
                case "post" -> Wire.object(post(op, type, call.path("id").asString(), depth + 1));
                case "reverse" -> Wire.object(reverse(op, type, call.path("id").asString(), depth + 1));
                case "registerBalance" -> {
                    String at = call.path("at").isString() ? call.path("at").asString().substring(0, 10) : null;
                    Map<String, JsonNode> dims = new HashMap<>();
                    for (var e : call.path("dimensions").properties()) dims.put(e.getKey(), e.getValue());
                    ObjectNode totals = balance(op, call.path("register").asString(), dims, at == null ? null : LocalDate.parse(at));
                    ObjectNode m = Json.object();
                    m.put("t", "map");
                    ArrayNode pairs = m.putArray("v");
                    for (var e : totals.properties()) pairs.addArray().add(e.getKey()).add(e.getValue());
                    yield m;
                }
                default -> throw PlatformException.badRequest("Unknown host call " + call.path("op").asString());
            };
            return com.fourveko.platform.worker.Protocol.hostResult(ok, null, null);
        } catch (PlatformException e) {
            return com.fourveko.platform.worker.Protocol.hostResult(null, e.hostCode(), e.getMessage());
        }
    }

    // ----- objects -----------------------------------------------------------------------

    private String kindOf(Op op, String type) {
        return op.model().kindOf(type).orElseThrow(() -> PlatformException.notFound("This application has no catalog or document named \"" + type + "\"."));
    }

    public ObjectNode get(Op op, String type, String id) {
        op.caller.require(kindOf(op, type) + ".read");
        ObjectNode o = objects.find(op.schema(), op.model(), type, id, false);
        if (o == null) throw PlatformException.notFound(type + " " + id + " does not exist.");
        return o;
    }

    public List<ObjectNode> list(Op op, String type, Map<String, JsonNode> filter, String search, int limit, int offset) {
        op.caller.require(kindOf(op, type) + ".read");
        return objects.list(op.schema(), op.model(), type, filter, search, limit, offset);
    }

    /** Objects as plain JSON with display names for themselves and every record they refer to. */
    public ArrayNode present(Op op, List<ObjectNode> list) {
        Map<String, String> names = new HashMap<>(presentations.forReferences(op.schema(), op.model(), list));
        for (ObjectNode o : list) names.put(o.path("type").asString() + "/" + o.path("id").asString(), Presentations.of(op.model(), o));
        ArrayNode out = Json.array();
        for (ObjectNode o : list) out.add(com.fourveko.platform.api.Plain.object(o, names));
        return out;
    }

    public ObjectNode present(Op op, ObjectNode o) {
        return (ObjectNode) present(op, List.of(o)).get(0);
    }

    /** Movements as plain JSON, with display names for referenced dimension values. */
    public ArrayNode presentMovements(Op op, ArrayNode movements) {
        List<JsonNode> values = new java.util.ArrayList<>();
        for (JsonNode m : movements) values.add(m.path("dimensions"));
        Map<String, String> names = presentations.forReferences(op.schema(), op.model(), values);
        ArrayNode out = Json.array();
        for (JsonNode x : movements) {
            ObjectNode row = ((ObjectNode) x).deepCopy();
            ObjectNode dims = Json.object();
            for (var e : x.path("dimensions").properties()) dims.set(e.getKey(), com.fourveko.platform.api.Plain.value(e.getValue(), names));
            ObjectNode measures = Json.object();
            for (var e : x.path("measures").properties()) measures.set(e.getKey(), com.fourveko.platform.api.Plain.value(e.getValue(), names));
            row.set("dimensions", dims);
            row.set("measures", measures);
            out.add(row);
        }
        return out;
    }

    private ObjectNode locked(Op op, String type, String id) {
        ObjectNode o = objects.find(op.schema(), op.model(), type, id, true);
        if (o == null || o.path("deleted").asBoolean()) throw PlatformException.notFound(type + " " + id + " does not exist.");
        return o;
    }

    private static ObjectNode afterHandler(ObjectNode result, ObjectNode fallback) {
        return result == null ? fallback : (ObjectNode) result.path("object");
    }

    /** Create or update an object, with BeforeCreate/BeforeSave handlers and validation. */
    public ObjectNode save(Op op, ObjectNode input, int depth) {
        String type = input.path("type").asString();
        String kind = kindOf(op, type);
        op.caller.require(kind + ".write");
        boolean isNew = !input.path("id").isString();
        ObjectNode o = input.deepCopy();
        o.put("kind", kind);
        ObjectNode current = null;
        if (!isNew) {
            current = locked(op, type, input.path("id").asString());
            if (current.path("version").asLong() != o.path("version").asLong(-1)) {
                throw PlatformException.conflict(type + " " + label(current) + " was changed by someone else (version " + current.path("version").asLong() + "); reload it and try again.");
            }
            if ("posted".equals(current.path("status").asString())) {
                throw PlatformException.conflict(type + " " + label(current) + " is posted; reverse it before changing it.");
            }
        }
        checkTypes(op, o);
        if (isNew) o = afterHandler(handler(op, type, "BeforeCreate", o, depth), o);
        o = afterHandler(handler(op, type, "BeforeSave", o, depth), o);
        // Platform-owned values are never taken from scripts or clients.
        o.put("kind", kind);
        o.put("type", type);
        o.put("deleted", false);
        if (isNew) {
            o.put("id", UUID.randomUUID().toString());
            o.put("version", 1);
        } else {
            o.put("id", current.path("id").asString());
            o.put("version", current.path("version").asLong());
        }
        if ("document".equals(kind)) {
            if (!o.path("date").isString()) o.put("date", op.today().toString());
            o.put("status", isNew ? "draft" : current.path("status").asString());
            if (!isNew) o.put("number", current.path("number").asString());
        }
        validate(op, o);
        if (isNew && "document".equals(kind)) {
            // Numbers come from a sequence (not transactional), so take one only for a valid document.
            o.put("number", objects.nextNumber(op.schema(), type));
        }
        if (isNew) {
            objects.insert(op.schema(), op.model(), o);
        } else if (!objects.update(op.schema(), op.model(), o, current.path("version").asLong())) {
            throw PlatformException.conflict(type + " " + label(current) + " was changed by someone else; reload it and try again.");
        }
        String id = o.path("id").asString();
        ObjectNode saved = objects.find(op.schema(), op.model(), type, id, false);
        event(op, type, id, isNew ? "AfterCreate" : "AfterSave", saved);
        audit(op, isNew ? "create" : "update", type, id, null);
        return saved;
    }

    private static String label(JsonNode o) {
        return o.path("number").isString() ? o.path("number").asString() : o.path("id").asString();
    }

    private void checkRef(Op op, String owner, FieldMeta f, JsonNode v) {
        if (f.type().isRef() && !Wire.isNull(v)) {
            String id = Wire.payload(v).path("id").asString();
            if (!objects.exists(op.schema(), op.model(), f.type().target(), id)) {
                throw PlatformException.validation(owner + ": \"" + f.name() + "\" refers to " + f.type().target() + " " + id + ", which does not exist.");
            }
        }
    }

    /**
     * Values must fit their declared types before any handler sees them. Required fields are
     * checked after the handlers, which may fill them in.
     */
    private void checkTypes(Op op, ObjectNode o) {
        String type = o.path("type").asString();
        for (FieldMeta f : op.model().fieldsOf(type)) {
            Fields.check(type, optional(f), o.path("fields").path(f.name()));
        }
        op.model().document(type).ifPresent(d -> {
            for (RowsMeta r : d.rows()) {
                int line = 0;
                for (JsonNode row : o.path("rows").path(r.name())) {
                    line++;
                    for (FieldMeta f : r.fields()) Fields.check(type + " " + r.name() + " line " + line, optional(f), row.path("fields").path(f.name()));
                }
            }
        });
    }

    private static FieldMeta optional(FieldMeta f) {
        return new FieldMeta(f.name(), f.type(), false, false, null);
    }

    /** The platform's own validation: it does not trust the script or the client. */
    private void validate(Op op, ObjectNode o) {
        String type = o.path("type").asString();
        JsonNode fields = o.path("fields");
        List<FieldMeta> declared = op.model().fieldsOf(type);
        for (String k : fields.propertyNames()) {
            if (declared.stream().noneMatch(f -> f.name().equals(k))) throw PlatformException.validation(type + " has no field \"" + k + "\".");
        }
        for (FieldMeta f : declared) {
            JsonNode v = fields.path(f.name());
            Fields.check(type, f, v);
            checkRef(op, type, f, v);
            if (f.unique() && !Wire.isNull(v) && objects.taken(op.schema(), op.model(), type, f, v, o.path("id").asString())) {
                throw PlatformException.validation(type + ": another record already has " + f.name() + " " + Wire.payload(v).asString() + ".");
            }
        }
        op.model().document(type).ifPresent(d -> {
            try {
                LocalDate.parse(o.path("date").asString());
            } catch (RuntimeException e) {
                throw PlatformException.validation(type + ": \"date\" must be a date.");
            }
            for (String k : o.path("rows").propertyNames()) {
                if (d.rows().stream().noneMatch(r -> r.name().equals(k))) throw PlatformException.validation(type + " has no rows \"" + k + "\".");
            }
            for (RowsMeta r : d.rows()) {
                int line = 0;
                for (JsonNode row : o.path("rows").path(r.name())) {
                    line++;
                    String owner = type + " " + r.name() + " line " + line;
                    for (String k : row.path("fields").propertyNames()) {
                        if (r.fields().stream().noneMatch(f -> f.name().equals(k))) throw PlatformException.validation(owner + " has no field \"" + k + "\".");
                    }
                    for (FieldMeta f : r.fields()) {
                        JsonNode v = row.path("fields").path(f.name());
                        Fields.check(owner, f, v);
                        checkRef(op, owner, f, v);
                    }
                }
            }
        });
    }

    public void delete(Op op, String type, String id, int depth) {
        op.caller.require(kindOf(op, type) + ".write");
        ObjectNode o = locked(op, type, id);
        if ("posted".equals(o.path("status").asString())) {
            throw PlatformException.conflict(type + " " + label(o) + " is posted; reverse it before deleting it.");
        }
        handler(op, type, "BeforeDelete", o, depth);
        objects.setState(op.schema(), op.model(), type, id, null, true);
        event(op, type, id, "AfterDelete", objects.find(op.schema(), op.model(), type, id, false));
        audit(op, "delete", type, id, null);
    }

    // ----- posting -----------------------------------------------------------------------

    private DocumentMeta documentMeta(Op op, String type) {
        return op.model().document(type).orElseThrow(() -> PlatformException.notFound("This application has no document named \"" + type + "\"."));
    }

    /**
     * Post a document: BeforePost validates, Post produces intents, the platform validates the
     * intents and writes the movements and the new status in this transaction. The row lock
     * and the unique index on active movements make a second posting impossible.
     */
    public ObjectNode post(Op op, String type, String id, int depth) {
        documentMeta(op, type);
        op.caller.require("document.post");
        ObjectNode doc = locked(op, type, id);
        if ("posted".equals(doc.path("status").asString())) {
            throw PlatformException.conflict(type + " " + label(doc) + " is already posted.");
        }
        handler(op, type, "BeforePost", doc, depth);
        ObjectNode result = handler(op, type, "Post", doc, depth);
        LocalDate period = LocalDate.parse(doc.path("date").asString());
        int line = 0;
        if (result != null) {
            for (JsonNode intent : result.path("intents")) {
                line++;
                applyIntent(op, type, id, period, line, intent);
            }
        }
        objects.setState(op.schema(), op.model(), type, id, "posted", false);
        ObjectNode posted = objects.find(op.schema(), op.model(), type, id, false);
        event(op, type, id, "AfterPost", posted);
        ObjectNode detail = Json.object();
        detail.put("movements", line);
        audit(op, "post", type, id, detail);
        return posted;
    }

    private void applyIntent(Op op, String type, String id, LocalDate period, int line, JsonNode intent) {
        if (!"registerMovement".equals(intent.path("kind").asString())) {
            throw new PlatformException(HttpStatus.NOT_IMPLEMENTED, "VKS5011", "host", "Accounting entries are not supported by this platform yet.");
        }
        String name = intent.path("register").asString();
        RegisterMeta r = op.model().register(name).orElseThrow(() -> PlatformException.validation("Unknown register " + name + "."));
        if (!r.isAccumulation()) throw PlatformException.validation(name + " is not an accumulation register.");
        String direction = intent.path("direction").asString();
        if (!direction.equals("in") && !direction.equals("out")) throw PlatformException.validation("Unknown movement direction " + direction + ".");
        JsonNode dims = intent.path("dimensions");
        JsonNode measures = intent.path("measures");
        check(name, r.dimensions(), dims, true);
        check(name, r.values(), measures, true);
        for (FieldMeta d : r.dimensions()) checkRef(op, name, d, dims.path(d.name()));
        registers.insert(op.schema(), r, type, id, period, line, direction, dims, measures);
    }

    private static void check(String owner, List<FieldMeta> declared, JsonNode values, boolean required) {
        for (String k : values.propertyNames()) {
            if (declared.stream().noneMatch(f -> f.name().equals(k))) throw PlatformException.validation(owner + " has no member \"" + k + "\".");
        }
        for (FieldMeta f : declared) {
            Fields.check(owner, new FieldMeta(f.name(), f.type(), required, false, null), values.path(f.name()));
        }
    }

    /** Reverse a posted document: its movements stop counting (kept for audit). */
    public ObjectNode reverse(Op op, String type, String id, int depth) {
        documentMeta(op, type);
        op.caller.require("document.post");
        ObjectNode doc = locked(op, type, id);
        if (!"posted".equals(doc.path("status").asString())) {
            throw PlatformException.conflict(type + " " + label(doc) + " is not posted.");
        }
        handler(op, type, "BeforeReverse", doc, depth);
        int n = registers.deactivate(op.schema(), op.model(), type, id);
        objects.setState(op.schema(), op.model(), type, id, "reversed", false);
        ObjectNode reversed = objects.find(op.schema(), op.model(), type, id, false);
        event(op, type, id, "AfterReverse", reversed);
        ObjectNode detail = Json.object();
        detail.put("movements", n);
        audit(op, "reverse", type, id, detail);
        return reversed;
    }

    public ObjectNode balance(Op op, String register, Map<String, JsonNode> dims, LocalDate at) {
        op.caller.require("register.read");
        RegisterMeta r = op.model().register(register).orElseThrow(() -> PlatformException.notFound("This application has no register named \"" + register + "\"."));
        if (!r.isAccumulation()) {
            throw new PlatformException(HttpStatus.NOT_IMPLEMENTED, "VKS5011", "host", register + " is an information register; queries on information registers are not supported yet.");
        }
        for (var e : dims.entrySet()) {
            FieldMeta d = r.dimensions().stream().filter(x -> x.name().equals(e.getKey())).findFirst()
                    .orElseThrow(() -> PlatformException.validation(register + " has no dimension \"" + e.getKey() + "\"."));
            Fields.check(register, d, e.getValue());
        }
        return registers.balance(op.schema(), r, dims, at);
    }

    public ArrayNode movements(Op op, String register, String recorderId) {
        op.caller.require("register.read");
        RegisterMeta r = op.model().register(register).orElseThrow(() -> PlatformException.notFound("This application has no register named \"" + register + "\"."));
        return registers.movements(op.schema(), r, recorderId);
    }

    /** Run a function of the application; returns its value (wire form). */
    public JsonNode function(Op op, String name, ArrayNode args) {
        ObjectNode entry = Json.object();
        entry.put("kind", "function");
        entry.put("name", name);
        entry.set("args", args);
        ObjectNode r = execute(op, entry, 0, "function " + name);
        if (!r.path("ok").asBoolean()) throw scriptError(r.path("error"));
        return r.path("value");
    }

    // ----- audit and after-commit events -------------------------------------------------

    private void audit(Op op, String action, String type, String id, JsonNode detail) {
        jdbc.update("INSERT INTO vks_audit (organization_id, application_id, actor, action, object_type, object_id, detail) VALUES (?, ?::uuid, ?, ?, ?, ?::uuid, ?::jsonb)", op.caller.organization(), op.app.id(),
                op.caller.user(), action, type, id, detail == null ? null : Json.write(detail));
    }

    /** Queue an After* event in this transaction, if the application handles it. */
    private void event(Op op, String type, String id, String event, ObjectNode object) {
        if (!op.app.hasHandler(type, event)) return;
        ObjectNode payload = Json.object();
        payload.put("actor", op.caller.user());
        ArrayNode roles = payload.putArray("roles");
        op.caller.roles().forEach(roles::add);
        ArrayNode caps = payload.putArray("capabilities");
        op.caller.capabilities().forEach(caps::add);
        payload.set("object", object);
        jdbc.update("INSERT INTO vks_outbox (organization_id, application_id, version, object_type, object_id, event, payload) VALUES (?, ?::uuid, ?, ?, ?::uuid, ?, ?::jsonb)", op.caller.organization(), op.app.id(),
                op.app.version(), type, id, event, Json.write(payload));
    }

    /**
     * Deliver pending After* events, each in its own transaction, as the user who caused it.
     * Failures are retried a few times and recorded; they never undo the committed change.
     */
    public int dispatchOutbox() {
        int delivered = 0;
        while (true) {
            Boolean more;
            long[] failedId = {0};
            try {
                more = tx.execute(status -> {
                    List<Map<String, Object>> rows = jdbc.queryForList("SELECT id, organization_id, application_id::text AS application_id, version, object_type, event, payload::text AS payload FROM vks_outbox "
                            + "WHERE processed_at IS NULL AND attempts < ? ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED", MAX_OUTBOX_ATTEMPTS);
                    if (rows.isEmpty()) return false;
                    Map<String, Object> row = rows.getFirst();
                    failedId[0] = ((Number) row.get("id")).longValue();
                    deliver(row);
                    jdbc.update("UPDATE vks_outbox SET processed_at = now(), attempts = attempts + 1 WHERE id = ?", failedId[0]);
                    return true;
                });
            } catch (RuntimeException e) {
                // Leave it for the next run rather than retrying in a tight loop.
                log.warn("after-commit event {} failed: {}", failedId[0], e.getMessage());
                jdbc.update("UPDATE vks_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?", e.getMessage(), failedId[0]);
                return delivered;
            }
            if (!Boolean.TRUE.equals(more)) return delivered;
            delivered++;
        }
    }

    private void deliver(Map<String, Object> row) {
        JsonNode payload = Json.parse((String) row.get("payload"));
        App app = apps.version((String) row.get("application_id"), ((Number) row.get("version")).intValue());
        List<String> roles = payload.path("roles").values().stream().map(JsonNode::asString).toList();
        Set<String> caps = Set.copyOf(payload.path("capabilities").values().stream().map(JsonNode::asString).toList());
        Caller caller = new Caller(payload.path("actor").asString(), (String) row.get("organization_id"), roles, caps);
        try (Op op = new Op(app, caller)) {
            ObjectNode r = handler(op, (String) row.get("object_type"), (String) row.get("event"), (ObjectNode) payload.path("object"), 1);
            if (r != null) {
                for (JsonNode l : r.path("logs")) {
                    if ("notify".equals(l.path("level").asString())) {
                        jdbc.update("INSERT INTO vks_notification (organization_id, application_id, recipient, message) VALUES (?, ?::uuid, ?, ?)", caller.organization(), app.id(), caller.user(), l.path("message").asString());
                    }
                }
            }
        }
    }
}
