-- Three persona columns on `companies` so the SMS/WhatsApp/email
-- conversation agent can sign as a real human and describe the desk
-- in its own words. Pre-#542 the agent was emitting the literal
-- string "[Operator Company Name]" because the system prompt said
-- "the operator's company" without a substitution hook — the model
-- helpfully filled in a placeholder.
--
--   agent_operator_name   — first name the agent uses ("Cole")
--   agent_persona_blurb   — short free-text positioning
--                           ("Procur is a fuel & food trading desk
--                           based in Houston…"); injected verbatim
--                           into the system prompt so the model has a
--                           grounded company description rather than
--                           making one up
--   agent_signature_sms   — short signoff for sms/whatsapp ("— Cole,
--                           Procur"); kept SEPARATE from
--                           email_signature_text because email
--                           signatures are HTML/multiline and SMS
--                           wants 1-2 words max
--
-- All nullable; NULL falls back to using `companies.name` and a
-- generic "from the desk" persona — no migration of existing rows.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS agent_operator_name text;

--> statement-breakpoint

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS agent_persona_blurb text;

--> statement-breakpoint

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS agent_signature_sms text;
