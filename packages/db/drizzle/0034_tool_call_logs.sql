CREATE TABLE IF NOT EXISTS "tool_call_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "user_id" uuid,
  "thread_id" uuid,
  "tool_name" text NOT NULL,
  "args" jsonb,
  "result_count" integer,
  "result_summary" jsonb,
  "success" boolean NOT NULL,
  "error_message" text,
  "latency_ms" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tool_call_logs_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "tool_call_logs_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "tool_call_logs_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_logs_company_tool_idx"
  ON "tool_call_logs" ("company_id", "tool_name", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_logs_tool_time_idx"
  ON "tool_call_logs" ("tool_name", "created_at");
