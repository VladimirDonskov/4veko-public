package com.fourveko.platform.api;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.app.ApplicationService;
import com.fourveko.platform.json.Json;
import com.fourveko.platform.json.Wire;
import com.fourveko.platform.metadata.Metadata.FieldMeta;
import com.fourveko.platform.metadata.Metadata.Model;
import com.fourveko.platform.metadata.Metadata.RegisterMeta;
import com.fourveko.platform.runtime.PlatformService;
import com.fourveko.platform.security.Caller;
import com.fourveko.platform.security.SecurityConfig.Callers;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.HashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * REST API of VekoScript applications. Responses are JSON text built by the platform's own
 * mapper, so decimals keep their exact scale. Objects carry a {@code display} name, and so do
 * the references inside them.
 */
@RestController
@RequestMapping(path = "/api/v1/apps", produces = MediaType.APPLICATION_JSON_VALUE)
public class ApiController {
    private final ApplicationService apps;
    private final PlatformService platform;
    private final Callers callers;

    public ApiController(ApplicationService apps, PlatformService platform, Callers callers) {
        this.apps = apps;
        this.platform = platform;
        this.callers = callers;
    }

    private static ResponseEntity<String> ok(JsonNode body) {
        return ResponseEntity.ok(Json.write(body));
    }

    private static JsonNode body(String text) {
        try {
            return Json.parse(text == null || text.isBlank() ? "{}" : text);
        } catch (RuntimeException e) {
            throw PlatformException.badRequest("The request body is not valid JSON.");
        }
    }

    private static String kindOf(String path) {
        return switch (path) {
            case "catalogs" -> "catalog";
            case "documents" -> "document";
            default -> throw PlatformException.notFound("Unknown collection \"" + path + "\"; use catalogs or documents.");
        };
    }

    private static void sameKind(Model m, String kind, String type) {
        if (!m.kindOf(type).map(kind::equals).orElse(false)) {
            throw PlatformException.notFound("This application has no " + kind + " named \"" + type + "\".");
        }
    }

    private static ObjectNode you(Caller caller) {
        ObjectNode you = Json.object();
        you.put("user", caller.user());
        ArrayNode roles = you.putArray("roles");
        caller.roles().forEach(roles::add);
        ArrayNode caps = you.putArray("capabilities");
        caller.capabilities().stream().sorted().forEach(caps::add);
        return you;
    }

    // ----- applications ------------------------------------------------------------------

    @GetMapping
    public ResponseEntity<String> applications() {
        Caller caller = callers.current();
        ObjectNode out = Json.object();
        ArrayNode list = out.putArray("applications");
        for (Map<String, Object> a : apps.list(caller)) {
            ObjectNode o = list.addObject();
            o.put("name", (String) a.get("name"));
            o.put("version", ((Number) a.get("version")).intValue());
            o.put("deployedAt", (String) a.get("deployed_at"));
            o.put("deployedBy", (String) a.get("deployed_by"));
        }
        out.set("you", you(caller));
        return ok(out);
    }

    @PostMapping(path = "/{app}/check", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> check(@PathVariable String app, @RequestBody String request) {
        callers.current();
        JsonNode result = apps.check(body(request).path("source").asString(""));
        ObjectNode out = Json.object();
        boolean failed = false;
        for (JsonNode d : result.path("diagnostics")) failed |= "error".equals(d.path("severity").asString());
        out.put("ok", !failed);
        out.set("diagnostics", result.path("diagnostics"));
        out.set("metadata", result.path("metadata"));
        out.set("handlers", result.path("handlers"));
        return ok(out);
    }

    private static String sourceText(JsonNode body) {
        if (!body.path("source").isString()) throw PlatformException.badRequest("Send a source string.");
        return body.path("source").asString();
    }

    private static Integer expectedVersion(JsonNode body, boolean required) {
        JsonNode version = body.path("expectedVersion");
        if (!required && version.isMissingNode()) return null;
        if (!version.isIntegralNumber() || !version.canConvertToInt() || version.asInt() < 0) {
            throw PlatformException.badRequest("expectedVersion must be a nonnegative integer. Use 0 for a new application.");
        }
        return version.asInt();
    }

    @PostMapping(path = "/{app}/preview", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> preview(@PathVariable String app, @RequestBody String request) {
        JsonNode b = body(request);
        return ok(apps.preview(callers.current(), app, sourceText(b), expectedVersion(b, true)));
    }

    @PutMapping(path = "/{app}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> deploy(@PathVariable String app, @RequestBody String request) {
        JsonNode b = body(request);
        ObjectNode result = apps.deploy(callers.current(), app, sourceText(b), b.path("approveDestructive").asBoolean(false), expectedVersion(b, false));
        return ok(result);
    }

    @GetMapping("/{app}")
    public ResponseEntity<String> describe(@PathVariable String app) {
        Caller caller = callers.current();
        ApplicationService.App a = apps.current(caller, app);
        ObjectNode out = Json.object();
        out.put("application", a.name());
        out.put("version", a.version());
        out.set("metadata", Json.tree(a.metadata()));
        ArrayNode handlers = out.putArray("handlers");
        a.handlers().stream().sorted().forEach(handlers::add);
        out.set("you", you(caller));
        return ok(out);
    }

    /** The source of the current version, for the configurator. */
    @GetMapping("/{app}/source")
    public ResponseEntity<String> source(@PathVariable String app) {
        Caller caller = callers.current();
        caller.requireRole("admin");
        ApplicationService.App a = apps.current(caller, app);
        ObjectNode out = Json.object();
        out.put("version", a.version());
        out.put("source", a.source());
        return ok(out);
    }

    // ----- catalogs and documents --------------------------------------------------------

    @GetMapping("/{app}/{collection:catalogs|documents}/{type}")
    public ResponseEntity<String> list(@PathVariable String app, @PathVariable String collection, @PathVariable String type, @RequestParam Map<String, String> query) {
        String kind = kindOf(collection);
        Caller caller = callers.current();
        ArrayNode out = platform.run(caller, app, op -> {
            Model m = apps.current(caller, app).metadata();
            sameKind(m, kind, type);
            Map<String, JsonNode> filter = new HashMap<>();
            int limit = 100;
            int offset = 0;
            String search = null;
            for (var e : query.entrySet()) {
                switch (e.getKey()) {
                    case "limit" -> limit = parseInt(e.getValue(), "limit");
                    case "offset" -> offset = parseInt(e.getValue(), "offset");
                    case "q" -> search = e.getValue();
                    default -> {
                        FieldMeta f = m.fieldsOf(type).stream().filter(x -> x.name().equals(e.getKey())).findFirst()
                                .orElseThrow(() -> PlatformException.validation(type + " has no field \"" + e.getKey() + "\"."));
                        filter.put(f.name(), Plain.field(type, f, Json.MAPPER.getNodeFactory().stringNode(e.getValue())));
                    }
                }
            }
            return platform.present(op, platform.list(op, type, filter, search, limit, offset));
        });
        return ok(out);
    }

    private static int parseInt(String s, String name) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            throw PlatformException.badRequest("\"" + name + "\" must be a whole number.");
        }
    }

    @PostMapping(path = "/{app}/{collection:catalogs|documents}/{type}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> create(@PathVariable String app, @PathVariable String collection, @PathVariable String type, @RequestBody String request) {
        String kind = kindOf(collection);
        Caller caller = callers.current();
        JsonNode b = body(request);
        ObjectNode saved = platform.run(caller, app, op -> {
            Model m = apps.current(caller, app).metadata();
            sameKind(m, kind, type);
            return platform.present(op, platform.save(op, Plain.toWire(m, kind, type, b, null), 0));
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(Json.write(saved));
    }

    @GetMapping("/{app}/{collection:catalogs|documents}/{type}/{id}")
    public ResponseEntity<String> get(@PathVariable String app, @PathVariable String collection, @PathVariable String type, @PathVariable String id) {
        String kind = kindOf(collection);
        Caller caller = callers.current();
        ObjectNode o = platform.run(caller, app, op -> {
            sameKind(apps.current(caller, app).metadata(), kind, type);
            return platform.present(op, platform.get(op, type, id));
        });
        return ok(o);
    }

    @PutMapping(path = "/{app}/{collection:catalogs|documents}/{type}/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> update(@PathVariable String app, @PathVariable String collection, @PathVariable String type, @PathVariable String id, @RequestBody String request) {
        String kind = kindOf(collection);
        Caller caller = callers.current();
        JsonNode b = body(request);
        ObjectNode saved = platform.run(caller, app, op -> {
            Model m = apps.current(caller, app).metadata();
            sameKind(m, kind, type);
            ObjectNode existing = platform.get(op, type, id);
            return platform.present(op, platform.save(op, Plain.toWire(m, kind, type, b, existing), 0));
        });
        return ok(saved);
    }

    @DeleteMapping("/{app}/{collection:catalogs|documents}/{type}/{id}")
    public ResponseEntity<String> delete(@PathVariable String app, @PathVariable String collection, @PathVariable String type, @PathVariable String id) {
        String kind = kindOf(collection);
        Caller caller = callers.current();
        platform.run(caller, app, op -> {
            sameKind(apps.current(caller, app).metadata(), kind, type);
            platform.delete(op, type, id, 0);
            return null;
        });
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{app}/documents/{type}/{id}/post")
    public ResponseEntity<String> post(@PathVariable String app, @PathVariable String type, @PathVariable String id) {
        return ok(platform.run(callers.current(), app, op -> platform.present(op, platform.post(op, type, id, 0))));
    }

    @PostMapping("/{app}/documents/{type}/{id}/reverse")
    public ResponseEntity<String> reverse(@PathVariable String app, @PathVariable String type, @PathVariable String id) {
        return ok(platform.run(callers.current(), app, op -> platform.present(op, platform.reverse(op, type, id, 0))));
    }

    // ----- registers and functions -------------------------------------------------------

    @GetMapping("/{app}/registers/{register}/balance")
    public ResponseEntity<String> balance(@PathVariable String app, @PathVariable String register, @RequestParam Map<String, String> query) {
        Caller caller = callers.current();
        ObjectNode totals = platform.run(caller, app, op -> {
            RegisterMeta r = apps.current(caller, app).metadata().register(register).orElseThrow(() -> PlatformException.notFound("This application has no register named \"" + register + "\"."));
            Map<String, JsonNode> dims = new HashMap<>();
            LocalDate at = null;
            for (var e : query.entrySet()) {
                if (e.getKey().equals("at")) {
                    try {
                        at = LocalDate.parse(e.getValue());
                    } catch (DateTimeParseException x) {
                        throw PlatformException.badRequest("\"at\" must be a date (YYYY-MM-DD).");
                    }
                    continue;
                }
                FieldMeta d = r.dimensions().stream().filter(x -> x.name().equals(e.getKey())).findFirst()
                        .orElseThrow(() -> PlatformException.validation(register + " has no dimension \"" + e.getKey() + "\"."));
                dims.put(d.name(), Plain.field(register, d, Json.MAPPER.getNodeFactory().stringNode(e.getValue())));
            }
            return platform.balance(op, register, dims, at);
        });
        ObjectNode out = Json.object();
        for (var e : totals.properties()) out.set(e.getKey(), Plain.value(e.getValue()));
        return ok(out);
    }

    @GetMapping("/{app}/registers/{register}/movements")
    public ResponseEntity<String> movements(@PathVariable String app, @PathVariable String register, @RequestParam String recorder) {
        return ok(platform.run(callers.current(), app, op -> platform.presentMovements(op, platform.movements(op, register, recorder))));
    }

    @PostMapping(path = "/{app}/functions/{name}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> function(@PathVariable String app, @PathVariable String name, @RequestBody String request) {
        JsonNode b = body(request);
        ArrayNode args = Json.array();
        for (JsonNode a : b.path("args")) args.add(argument(a));
        JsonNode value = platform.run(callers.current(), app, op -> platform.function(op, name, args));
        ObjectNode out = Json.object();
        out.set("value", Plain.value(value));
        return ok(out);
    }

    /** Plain JSON arguments: strings, booleans, null, whole numbers and decimals. */
    private static JsonNode argument(JsonNode a) {
        if (a.isNull()) return Wire.nul();
        if (a.isBoolean()) return Wire.bool(a.asBoolean());
        if (a.isIntegralNumber()) return Wire.integer(a.asLong());
        if (a.isNumber()) return Wire.dec(a.decimalValue());
        if (a.isString()) return Wire.str(a.asString());
        throw PlatformException.badRequest("Function arguments are strings, numbers, booleans or null.");
    }
}
