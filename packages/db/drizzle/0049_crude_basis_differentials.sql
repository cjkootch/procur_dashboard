-- Crude basis differentials.
--
-- Named crude grades (Azeri Light, Es Sider, Bonny Light, Urals, …)
-- don't have their own spot-price feeds — they trade as a structural
-- premium or discount against a marker (Brent, WTI, Dubai). This
-- migration adds two columns to crude_grades so we can store the
-- mapping + differential and resolve "fair value for Azeri Light" =
-- live marker spot + differential.
--
-- Differential sign convention: positive = premium over marker,
-- negative = discount. E.g. Azeri Light typically trades +$1.50–
-- +$3.00 over Brent (light-sweet quality premium); Urals sits
-- materially below Brent post-2022 (Russian-origin discount).
--
-- Marker grades (isMarker=true) keep both columns NULL — they ARE
-- the markers; they don't have a basis.

ALTER TABLE crude_grades
  ADD COLUMN marker_slug text,
  ADD COLUMN differential_usd_per_bbl numeric;
--> statement-breakpoint

-- FK back to crude_grades.slug for referential integrity.
-- ON DELETE SET NULL — if a marker row is removed, dependent grades
-- keep their differential value but lose the link.
ALTER TABLE crude_grades
  ADD CONSTRAINT crude_grades_marker_fk
  FOREIGN KEY (marker_slug)
  REFERENCES crude_grades(slug)
  ON DELETE SET NULL;
--> statement-breakpoint

-- Index for the common "list grades sharing this marker" query.
CREATE INDEX crude_grades_marker_slug_idx
  ON crude_grades (marker_slug)
  WHERE marker_slug IS NOT NULL;
