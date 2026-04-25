-- Audit log: explicit actor (impersonator) attribution.
--
-- `user_id` keeps recording the customer-side user (because that's whose
-- session ran the action — preserves existing per-user filters and
-- joins). `actor_user_id` is the staff user who drove the request via
-- Clerk impersonation, sourced from sessionClaims.act.sub. Null in
-- normal sessions; set on every audit write made during impersonation.
--
-- Indexed so the admin audit viewer can filter "all events impersonated
-- by Alice" quickly.

ALTER TABLE "audit_log" ADD COLUMN "actor_user_id" uuid REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS "audit_actor_idx" ON "audit_log" ("actor_user_id");
