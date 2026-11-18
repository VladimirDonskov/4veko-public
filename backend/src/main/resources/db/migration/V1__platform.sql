-- Platform tables. Application data lives in one generated schema per deployed application.

CREATE TABLE vks_application (
    id              uuid PRIMARY KEY,
    organization_id text        NOT NULL,
    name            text        NOT NULL,
    schema_name     text        NOT NULL UNIQUE,
    current_version int,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE TABLE vks_application_version (
    application_id uuid        NOT NULL REFERENCES vks_application (id),
    version        int         NOT NULL,
    source         text        NOT NULL,
    metadata       jsonb       NOT NULL,
    handlers       jsonb       NOT NULL,
    plan           jsonb       NOT NULL,
    ddl            jsonb       NOT NULL,
    deployed_by    text        NOT NULL,
    deployed_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_id, version)
);

-- Who did what. Written in the same transaction as the change it describes.
CREATE TABLE vks_audit (
    id              bigserial PRIMARY KEY,
    organization_id text        NOT NULL,
    application_id  uuid,
    actor           text        NOT NULL,
    action          text        NOT NULL,
    object_type     text,
    object_id       uuid,
    detail          jsonb,
    at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vks_audit_object ON vks_audit (application_id, object_id);

-- After* events, written with the change and delivered after it commits.
CREATE TABLE vks_outbox (
    id              bigserial PRIMARY KEY,
    organization_id text        NOT NULL,
    application_id  uuid        NOT NULL REFERENCES vks_application (id),
    version         int         NOT NULL,
    object_type     text        NOT NULL,
    object_id       uuid        NOT NULL,
    event           text        NOT NULL,
    payload         jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    attempts        int         NOT NULL DEFAULT 0,
    last_error      text
);
CREATE INDEX vks_outbox_pending ON vks_outbox (id) WHERE processed_at IS NULL;

-- Messages from notify() in after-commit handlers, for the user interface to show.
CREATE TABLE vks_notification (
    id              bigserial PRIMARY KEY,
    organization_id text        NOT NULL,
    application_id  uuid        NOT NULL,
    recipient       text        NOT NULL,
    message         text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
