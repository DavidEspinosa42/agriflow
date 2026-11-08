CREATE TABLE `managers` (
	`manager_id` varchar(64) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`revoked` boolean NOT NULL DEFAULT false,
	`created_at_ms` bigint NOT NULL,
	CONSTRAINT `managers_manager_id` PRIMARY KEY(`manager_id`),
	CONSTRAINT `managers_token_hash_unique` UNIQUE(`token_hash`)
);
