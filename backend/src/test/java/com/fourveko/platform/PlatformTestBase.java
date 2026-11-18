package com.fourveko.platform;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fourveko.platform.json.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import javax.crypto.spec.SecretKeySpec;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Runs the platform against a real PostgreSQL database (default: the local development
 * container, database vekoscript_test; override with VKS_TEST_DB_URL) and the real `vks`
 * worker binary. Each test uses its own organization, so tests do not see each other's data.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=${VKS_TEST_DB_URL:jdbc:postgresql://localhost:5433/vekoscript_test}",
        "vks.security.jwt-secret=test-only-secret-0123456789-abcdefghij",
        "vks.outbox.poll-ms=3600000",
})
@AutoConfigureMockMvc
public abstract class PlatformTestBase {
    protected static final String SECRET = "test-only-secret-0123456789-abcdefghij";

    @Autowired
    protected MockMvc mvc;

    @Autowired
    protected JdbcTemplate jdbc;

    protected final String org = "org-" + UUID.randomUUID();

    protected static String inventorySource() {
        try {
            return Files.readString(Path.of(System.getProperty("vks.engine.dir", "../engine/vekoscript"), "examples", "inventory.vks"), StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    protected static String token(String org, String user, String... roles) {
        var encoder = new NimbusJwtEncoder(new ImmutableSecret<>(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256")));
        var claims = JwtClaimsSet.builder().subject(user).claim("org", org).claim("roles", List.of(roles)).issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(600)).build();
        return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    }

    protected record Response(int status, JsonNode body) {}

    protected Response call(MockHttpServletRequestBuilder request, String token, Object body) {
        try {
            if (token != null) request.header("Authorization", "Bearer " + token);
            if (body != null) request.contentType(MediaType.APPLICATION_JSON).content(body instanceof String s ? s : Json.write(body));
            MvcResult r = mvc.perform(request).andReturn();
            String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
            return new Response(r.getResponse().getStatus(), text.isEmpty() ? Json.MAPPER.nullNode() : Json.parse(text));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    protected Response GET(String path, String token) {
        return call(get(path), token, null);
    }

    protected Response POST(String path, String token, Object body) {
        return call(post(path), token, body == null ? "{}" : body);
    }

    protected Response PUT(String path, String token, Object body) {
        return call(put(path), token, body);
    }

    protected Response DELETE(String path, String token) {
        return call(delete(path), token, null);
    }

    protected static ObjectNode obj(Object... kv) {
        ObjectNode o = Json.object();
        for (int i = 0; i < kv.length; i += 2) {
            o.set((String) kv[i], Json.tree(kv[i + 1]));
        }
        return o;
    }

    protected Response deploy(String app, String token, String source, boolean approve) {
        return PUT("/api/v1/apps/" + app, token, obj("source", source, "approveDestructive", approve));
    }

    protected String schemaOf(String app) {
        return jdbc.queryForObject("SELECT schema_name FROM vks_application WHERE organization_id = ? AND name = ?", String.class, org, app);
    }
}
