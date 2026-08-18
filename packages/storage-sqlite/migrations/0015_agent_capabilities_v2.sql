-- Agent capabilities V2 uses a versioned JSON envelope for newly written
-- revisions. Historical V1 JSON and content digests remain immutable; this
-- migration advances the Core compatibility boundary so older binaries reject
-- databases that may contain V2 revisions.
SELECT 1;
