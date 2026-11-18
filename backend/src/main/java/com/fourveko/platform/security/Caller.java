package com.fourveko.platform.security;

import com.fourveko.platform.PlatformException;
import java.util.List;
import java.util.Set;

/** The authenticated user of a request: organization (tenant), roles and granted capabilities. */
public record Caller(String user, String organization, List<String> roles, Set<String> capabilities) {

    public boolean can(String capability) {
        return capabilities.contains("*") || capabilities.contains(capability);
    }

    public void require(String capability) {
        if (!can(capability)) {
            throw PlatformException.forbidden(user + " does not have the \"" + capability + "\" permission.");
        }
    }

    public void requireRole(String role) {
        if (!roles.contains(role)) {
            throw PlatformException.forbidden(user + " needs the \"" + role + "\" role.");
        }
    }
}
