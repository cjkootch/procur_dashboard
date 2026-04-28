-- Track the last time each user invoked the Discover assistant's
-- "what's new" tool. The next call computes the delta as opportunities
-- posted after this timestamp, then bumps it. NULL = first call, falls
-- back to a 7-day window so users get something useful immediately.

ALTER TABLE "users"
  ADD COLUMN "last_assistant_seen_at" timestamp;
