-- Region promotion break glass (HA-PLAN H26, W13 review). Additive only.
--
-- 1 when the operator confirmed the promotion with break glass: the old region still held a valid
-- lease. Every database step re-checks its lease at its own fenced generation and refuses a live
-- foreign lease unless this is set, on whichever control plane runs or resumes the step. Existing
-- rows were confirmed without it.
ALTER TABLE region_promotions ADD COLUMN break_glass INTEGER NOT NULL DEFAULT 0 CHECK (break_glass IN (0, 1));
