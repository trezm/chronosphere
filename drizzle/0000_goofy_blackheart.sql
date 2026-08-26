CREATE TABLE `pull_request_states` (
	`viewer` text NOT NULL,
	`repository` text NOT NULL,
	`pull_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`viewer`, `repository`, `pull_number`, `head_sha`)
);
--> statement-breakpoint
PRAGMA optimize;
