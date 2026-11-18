package com.fourveko.platform;

import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;

/**
 * A failure reported to API clients and, inside script host calls, to the script. {@code kind}
 * follows the VekoScript error kinds (validation failures from the platform use "host").
 */
public class PlatformException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final String kind;
    private final int line;
    private final int col;
    private final transient JsonNode details;

    public PlatformException(HttpStatus status, String code, String kind, String message, int line, int col, JsonNode details) {
        super(message);
        this.status = status;
        this.code = code;
        this.kind = kind;
        this.line = line;
        this.col = col;
        this.details = details;
    }

    public PlatformException(HttpStatus status, String code, String kind, String message) {
        this(status, code, kind, message, 0, 0, null);
    }

    public static PlatformException notFound(String message) {
        return new PlatformException(HttpStatus.NOT_FOUND, "VKS5001", "host", message);
    }

    public static PlatformException conflict(String message) {
        return new PlatformException(HttpStatus.CONFLICT, "VKS5002", "host", message);
    }

    public static PlatformException validation(String message) {
        return new PlatformException(HttpStatus.UNPROCESSABLE_CONTENT, "VKS5003", "host", message);
    }

    public static PlatformException forbidden(String message) {
        return new PlatformException(HttpStatus.FORBIDDEN, "VKS5004", "permission", message);
    }

    public static PlatformException badRequest(String message) {
        return new PlatformException(HttpStatus.BAD_REQUEST, "VKS5007", "host", message);
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public String kind() {
        return kind;
    }

    public int line() {
        return line;
    }

    public int col() {
        return col;
    }

    public JsonNode details() {
        return details;
    }

    /** The error code a script sees when this failure answers one of its host calls. */
    public String hostCode() {
        if ("rejected".equals(kind)) return "rejected";
        if ("limit".equals(kind)) return "limit";
        return switch (status) {
            case NOT_FOUND -> "notFound";
            case CONFLICT -> "conflict";
            case FORBIDDEN -> "permission";
            case UNPROCESSABLE_CONTENT, BAD_REQUEST -> "validation";
            default -> "internal";
        };
    }
}
