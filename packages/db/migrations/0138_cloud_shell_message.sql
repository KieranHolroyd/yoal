-- Cloud shell start failures (D236). Additive only.
--
-- Why the last start failed (the container kept exiting, or the node never started it), shown on
-- the cloud shell page instead of a shell that says "starting" forever. Cleared by the next start.
ALTER TABLE cloud_shells ADD COLUMN message TEXT;
