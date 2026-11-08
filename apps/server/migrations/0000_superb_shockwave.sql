CREATE TABLE `devices` (
	`device_id` varchar(64) NOT NULL,
	`tank_id` varchar(64) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`revoked` boolean NOT NULL DEFAULT false,
	`created_at_ms` bigint NOT NULL,
	CONSTRAINT `devices_device_id` PRIMARY KEY(`device_id`),
	CONSTRAINT `devices_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`session_id` varchar(36) NOT NULL,
	`device_id` varchar(64) NOT NULL,
	`tank_id` varchar(64) NOT NULL,
	`operator_id` varchar(64) NOT NULL,
	`machine_id` varchar(64) NOT NULL,
	`started_at_ms` bigint NOT NULL,
	`ended_at_ms` bigint NOT NULL,
	`liters` double NOT NULL,
	`end_reason` varchar(32) NOT NULL,
	`received_at_ms` bigint NOT NULL,
	CONSTRAINT `transactions_session_id` PRIMARY KEY(`session_id`)
);
--> statement-breakpoint
CREATE INDEX `transactions_started_idx` ON `transactions` (`started_at_ms`);--> statement-breakpoint
CREATE INDEX `transactions_machine_idx` ON `transactions` (`machine_id`);