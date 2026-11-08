CREATE TRIGGER `transactions_no_update` BEFORE UPDATE ON `transactions` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transactions are append-only';
--> statement-breakpoint
CREATE TRIGGER `transactions_no_delete` BEFORE DELETE ON `transactions` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transactions are append-only';
