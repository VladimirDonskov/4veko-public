package com.fourveko.platform.api;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.json.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import tools.jackson.databind.node.ObjectNode;

/** Errors as RFC 9457 problem details with the VekoScript code, kind and position. */
@RestControllerAdvice
public class ApiErrors {
    private static final Logger log = LoggerFactory.getLogger(ApiErrors.class);

    private static ResponseEntity<String> problem(HttpStatus status, String code, String kind, String message, int line, int col, ObjectNode extra) {
        ObjectNode p = Json.object();
        p.put("type", "about:blank");
        p.put("title", status.getReasonPhrase());
        p.put("status", status.value());
        p.put("detail", message);
        p.put("code", code);
        p.put("kind", kind);
        if (line > 0) {
            p.put("line", line);
            p.put("col", col);
        }
        if (extra != null) p.setAll(extra);
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(Json.write(p));
    }

    @ExceptionHandler(PlatformException.class)
    public ResponseEntity<String> platform(PlatformException e) {
        if (e.status().is5xxServerError()) log.warn("{} {}: {}", e.status().value(), e.code(), e.getMessage());
        ObjectNode extra = e.details() instanceof ObjectNode o ? o : null;
        return problem(e.status(), e.code(), e.kind(), e.getMessage(), e.line(), e.col(), extra);
    }

    /** A constraint caught a conflict the checks did not (for example two concurrent writers). */
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<String> integrity(DataIntegrityViolationException e) {
        log.info("integrity violation: {}", e.getMostSpecificCause().getMessage());
        return problem(HttpStatus.CONFLICT, "VKS5002", "host", "The change conflicts with existing data (" + e.getMostSpecificCause().getMessage().lines().findFirst().orElse("") + ").", 0, 0, null);
    }

    /** Any other storage failure: the operation's transaction has been rolled back. */
    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<String> storage(DataAccessException e) {
        log.error("storage failure", e);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "VKS5012", "host", "Storage failed; nothing was changed.", 0, 0, null);
    }
}
