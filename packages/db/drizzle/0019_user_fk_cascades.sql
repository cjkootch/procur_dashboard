-- User FK cascade rules: make `db.delete(users)` (driven by Clerk's
-- `user.deleted` webhook) actually work.
--
-- Before this migration every user FK defaulted to RESTRICT, so deleting
-- a user with even one assigned pursuit / authored comment / saved
-- opportunity blew up the webhook handler. The user got "stuck" — Clerk
-- says deleted but our row stayed forever.
--
-- Strategy:
--   - Nullable FKs (assignment / reviewer / submitter / audit attribution):
--     SET NULL → keep the parent row, clear the user link.
--   - Required FKs on user-owned data (their bookmarks, their alerts,
--     their assistant threads, their authored comments): CASCADE → the
--     row goes with the user.
--
-- Audit log is special: userId becomes NULL (we keep the audit trail
-- with action + entity intact, but no longer point at a user that no
-- longer exists). Cascading audit_log would silently destroy compliance
-- evidence — never do that.

--> statement-breakpoint
ALTER TABLE "pursuits"
  DROP CONSTRAINT IF EXISTS "pursuits_assigned_user_id_users_id_fk",
  ADD CONSTRAINT "pursuits_assigned_user_id_users_id_fk"
    FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "pursuits"
  DROP CONSTRAINT IF EXISTS "pursuits_capture_manager_id_users_id_fk",
  ADD CONSTRAINT "pursuits_capture_manager_id_users_id_fk"
    FOREIGN KEY ("capture_manager_id") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "pursuit_tasks"
  DROP CONSTRAINT IF EXISTS "pursuit_tasks_assigned_user_id_users_id_fk",
  ADD CONSTRAINT "pursuit_tasks_assigned_user_id_users_id_fk"
    FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "pursuit_gate_reviews"
  DROP CONSTRAINT IF EXISTS "pursuit_gate_reviews_reviewer_user_id_users_id_fk",
  ADD CONSTRAINT "pursuit_gate_reviews_reviewer_user_id_users_id_fk"
    FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "proposals"
  DROP CONSTRAINT IF EXISTS "proposals_submitted_by_users_id_fk",
  ADD CONSTRAINT "proposals_submitted_by_users_id_fk"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "proposal_comments"
  DROP CONSTRAINT IF EXISTS "proposal_comments_created_by_users_id_fk",
  ADD CONSTRAINT "proposal_comments_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "proposal_comments"
  DROP CONSTRAINT IF EXISTS "proposal_comments_resolved_by_users_id_fk",
  ADD CONSTRAINT "proposal_comments_resolved_by_users_id_fk"
    FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "saved_opportunities"
  DROP CONSTRAINT IF EXISTS "saved_opportunities_user_id_users_id_fk",
  ADD CONSTRAINT "saved_opportunities_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "alert_profiles"
  DROP CONSTRAINT IF EXISTS "alert_profiles_user_id_users_id_fk",
  ADD CONSTRAINT "alert_profiles_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "assistant_threads"
  DROP CONSTRAINT IF EXISTS "assistant_threads_user_id_users_id_fk",
  ADD CONSTRAINT "assistant_threads_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "audit_log"
  DROP CONSTRAINT IF EXISTS "audit_log_user_id_users_id_fk",
  ADD CONSTRAINT "audit_log_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
