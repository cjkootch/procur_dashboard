CREATE TABLE "proposal_shreds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"section_path" text DEFAULT '' NOT NULL,
	"section_title" text,
	"sentence_text" text NOT NULL,
	"shred_type" text DEFAULT 'none' NOT NULL,
	"accounted_for" boolean DEFAULT false NOT NULL,
	"addressed_in_section" text,
	"source_document_id" uuid,
	"source_page" integer,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_shreds" ADD CONSTRAINT "proposal_shreds_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_shreds" ADD CONSTRAINT "proposal_shreds_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_shreds_proposal_idx" ON "proposal_shreds" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_shreds_proposal_section_idx" ON "proposal_shreds" USING btree ("proposal_id","section_path");
