-- Credential tables are removed from the read-only analytics role.
--
-- `devanalytics_ro` backs the AI analytics path. It has no business reading
-- token hashes, even though a hash is not directly usable: the fewer rows that
-- path can reach, the smaller the consequence of a mistake above it. The
-- SQL guard's table allowlist already blocks these, and this makes the
-- database agree, so neither control depends on the other.
revoke select on api_tokens from devanalytics_ro;
revoke select on org_members from devanalytics_ro;
