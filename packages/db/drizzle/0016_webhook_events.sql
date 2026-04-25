CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text,
	"event_type" text,
	"company_id" uuid,
	"signature_valid" boolean DEFAULT true NOT NULL,
	"response_status" integer NOT NULL,
	"processed_at" timestamp,
	"error_message" text,
	"payload" jsonb,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_events_provider_received_idx" ON "webhook_events" USING btree ("provider","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_event_id_idx" ON "webhook_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_company_idx" ON "webhook_events" USING btree ("company_id");
