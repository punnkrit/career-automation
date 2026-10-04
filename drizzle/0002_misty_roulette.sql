CREATE TABLE `job_status_events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`previous_status` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_status_events_job_changed` ON `job_status_events` (`job_id`,`changed_at`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `applied_at` text;
