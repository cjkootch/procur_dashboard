CREATE TABLE "contract_modifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"mod_number" text NOT NULL,
	"action_date" date,
	"action_type" text DEFAULT 'other' NOT NULL,
	"description" text,
	"funding_change" numeric(20, 2),
	"currency" text DEFAULT 'USD',
	"document_url" text,
	"source" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_clins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"clin_number" text NOT NULL,
	"title" text NOT NULL,
	"clin_type" text DEFAULT 'fixed_price' NOT NULL,
	"quantity" numeric(14, 4),
	"unit_of_measure" text,
	"unit_price" numeric(14, 4),
	"amount" numeric(20, 2),
	"period_start" date,
	"period_end" date,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_task_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" text,
	"period_start" date,
	"period_end" date,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_modifications" ADD CONSTRAINT "contract_modifications_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_clins" ADD CONSTRAINT "contract_clins_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_task_areas" ADD CONSTRAINT "contract_task_areas_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_modifications_contract_idx" ON "contract_modifications" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_clins_contract_idx" ON "contract_clins" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_task_areas_contract_idx" ON "contract_task_areas" USING btree ("contract_id");
