package com.fourveko.platform.security;

import com.fourveko.platform.PlatformException;
import com.fourveko.platform.config.VksProperties;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.stereotype.Component;

/** Stateless bearer-token security. Every API call needs a valid token with an organization. */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        http.csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(a -> a.requestMatchers("/health").permitAll().anyRequest().authenticated())
                .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()));
        return http.build();
    }

    @Bean
    JwtDecoder jwtDecoder(VksProperties properties) {
        String secret = properties.security().jwtSecret();
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("vks.security.jwt-secret must be set to at least 32 bytes (VKS_JWT_SECRET).");
        }
        SecretKeySpec key = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        return NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
    }

    /** Resolves the {@link Caller} of the current request. */
    @Component
    public static class Callers {
        private final VksProperties properties;

        public Callers(VksProperties properties) {
            this.properties = properties;
        }

        public Caller current() {
            var auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
                throw PlatformException.forbidden("Not signed in.");
            }
            String org = jwt.getClaimAsString("org");
            if (org == null || org.isBlank()) {
                throw PlatformException.forbidden("The token has no organization.");
            }
            List<String> roles = jwt.getClaimAsStringList("roles");
            roles = roles == null ? List.of() : List.copyOf(roles);
            return new Caller(jwt.getSubject(), org, roles, capabilities(roles));
        }

        public Set<String> capabilities(List<String> roles) {
            Set<String> caps = new LinkedHashSet<>();
            for (String r : roles) {
                caps.addAll(properties.security().roles().getOrDefault(r, List.of()));
            }
            return Set.copyOf(caps);
        }
    }
}
