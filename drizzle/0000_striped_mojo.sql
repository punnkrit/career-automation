CREATE TABLE `analyses` (
	`job_id` text PRIMARY KEY NOT NULL,
	`decision_memo_json` text NOT NULL,
	`decision` text NOT NULL,
	`fit_tier` text NOT NULL,
	`sponsorship_tier` text NOT NULL,
	`lane` text NOT NULL,
	`resume_strategy` text NOT NULL,
	`confidence` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`job_id` text PRIMARY KEY NOT NULL,
	`packet_owner_key` text NOT NULL,
	`resume_strategy` text NOT NULL,
	`status` text NOT NULL,
	`packet_date` text NOT NULL,
	`applied_date` text,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `daily_reports` (
	`report_date` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`object_key`) REFERENCES `stored_objects`(`object_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_source_resolution_events` (
	`resolution_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`resolution_status` text NOT NULL,
	`source_tier` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_source_events_job` ON `job_source_resolution_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_sources` (
	`job_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`source_tier` text NOT NULL,
	`candidate_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `url`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_sources_job` ON `job_sources` (`job_id`,`candidate_order`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`url` text,
	`description` text DEFAULT '' NOT NULL,
	`found_date` text NOT NULL,
	`posted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`lane_hint` text,
	`status` text DEFAULT 'new' NOT NULL,
	`dedupe_key` text NOT NULL,
	`company_key` text,
	`title_key` text,
	`description_fingerprint` text,
	`opportunity_key` text,
	`opportunity_grouping_version` integer,
	`discovery_url` text,
	`source_tier` text DEFAULT 'unverified' NOT NULL,
	`source_status` text DEFAULT 'unresolved' NOT NULL,
	`source_checked_at` text,
	`source_resolution_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_key_unique` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_jobs_found_created` ON `jobs` (`found_date`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_status_found` ON `jobs` (`status`,`found_date`);--> statement-breakpoint
CREATE INDEX `idx_jobs_company_status` ON `jobs` (`company_key`,`status`,`found_date`);--> statement-breakpoint
CREATE INDEX `idx_jobs_opportunity_key` ON `jobs` (`opportunity_key`);--> statement-breakpoint
CREATE TABLE `migration_batches` (
	`import_id` text NOT NULL,
	`table_name` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload_sha256` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`import_id`, `table_name`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `networking_companies` (
	`company_key` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`research_json` text,
	`researched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `networking_contacts` (
	`contact_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_key` text NOT NULL,
	`name` text NOT NULL,
	`linkedin_url` text DEFAULT '' NOT NULL,
	`request_accepted` integer DEFAULT 0 NOT NULL,
	`responded` integer DEFAULT 0 NOT NULL,
	`coffee_chat` integer DEFAULT 0 NOT NULL,
	`referral` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_key`) REFERENCES `networking_companies`(`company_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_networking_contacts_company_name` ON `networking_contacts` (`company_key`,`name`);--> statement-breakpoint
CREATE INDEX `idx_networking_contacts_company` ON `networking_contacts` (`company_key`);--> statement-breakpoint
CREATE TABLE `networking_events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_key` text NOT NULL,
	`contact_id` integer,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`company_key`) REFERENCES `networking_companies`(`company_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `networking_contacts`(`contact_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_networking_events_company` ON `networking_events` (`company_key`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `networking_role_research` (
	`company_key` text NOT NULL,
	`opportunity_key` text NOT NULL,
	`job_id` text NOT NULL,
	`title` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`jd_fingerprint` text NOT NULL,
	`company_researched_at` text DEFAULT '' NOT NULL,
	`research_json` text NOT NULL,
	`researched_at` text NOT NULL,
	PRIMARY KEY(`company_key`, `opportunity_key`),
	FOREIGN KEY (`company_key`) REFERENCES `networking_companies`(`company_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_networking_role_research_company` ON `networking_role_research` (`company_key`);--> statement-breakpoint
CREATE TABLE `operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`operation_type` text NOT NULL,
	`resource_key` text NOT NULL,
	`execution_target` text DEFAULT 'workstation' NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_operations_status_created` ON `operations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_operations_type_status_created` ON `operations` (`operation_type`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `profile_versions` (
	`context_version` text PRIMARY KEY NOT NULL,
	`resume_parser` text NOT NULL,
	`resume_strategies_json` text NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text,
	`run_type` text NOT NULL,
	`prompt_object_key` text,
	`output_object_key` text,
	`status` text NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`prompt_object_key`) REFERENCES `stored_objects`(`object_key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`output_object_key`) REFERENCES `stored_objects`(`object_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_runs_job_created` ON `runs` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_type_created` ON `runs` (`run_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `search_requests` (
	`run_id` text NOT NULL,
	`request_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`lane` text NOT NULL,
	`query` text NOT NULL,
	`location` text NOT NULL,
	`location_source` text NOT NULL,
	`page` integer NOT NULL,
	`next_page_token` text,
	`status` text NOT NULL,
	`serpapi_search_id` text,
	`poll_count` integer DEFAULT 0 NOT NULL,
	`fetched` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`unique_jobs` integer DEFAULT 0 NOT NULL,
	`new_opportunities` integer DEFAULT 0 NOT NULL,
	`cached` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`error_type` text,
	`error_message` text,
	`raw_object_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `request_key`),
	FOREIGN KEY (`run_id`) REFERENCES `search_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_search_requests_run_sequence` ON `search_requests` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `search_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`status` text NOT NULL,
	`request_json` text NOT NULL,
	`planned_requests_json` text NOT NULL,
	`result_json` text,
	`raw_object_prefix` text NOT NULL,
	`normalized_object_key` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`operation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_runs_operation_id_unique` ON `search_runs` (`operation_id`);--> statement-breakpoint
CREATE TABLE `stored_objects` (
	`object_key` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`owner_key` text NOT NULL,
	`logical_name` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`etag` text,
	`sha256` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stored_objects_unique_logical` ON `stored_objects` (`category`,`owner_key`,`logical_name`);--> statement-breakpoint
CREATE INDEX `idx_stored_objects_owner` ON `stored_objects` (`category`,`owner_key`);
