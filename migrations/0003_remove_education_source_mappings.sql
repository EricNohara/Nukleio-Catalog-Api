-- Remove the superseded source-mapping table if it exists locally or remotely.
-- This does not touch educational_institutions.

DROP TABLE IF EXISTS educational_institution_sources;
