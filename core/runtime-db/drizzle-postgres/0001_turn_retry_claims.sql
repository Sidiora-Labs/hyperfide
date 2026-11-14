CREATE TABLE "platform"."turn_retry_claims" (
	"thread_id" text NOT NULL,
	"original_request_id" text NOT NULL,
	"attempt" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "turn_retry_claims_thread_id_original_request_id_attempt_pk" PRIMARY KEY("thread_id","original_request_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "platform"."turn_retry_claims" ADD CONSTRAINT "turn_retry_claims_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;
