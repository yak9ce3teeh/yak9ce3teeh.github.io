CREATE TABLE `papers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text,
	`sha256` text NOT NULL,
	`metadata` text NOT NULL,
	`created` text NOT NULL,
	`zotero` text
);

CREATE UNIQUE INDEX `papers_source_id_unique` ON `papers` (`source_id`);
CREATE UNIQUE INDEX `papers_sha256_unique` ON `papers` (`sha256`);
CREATE TABLE translation_limits(day TEXT PRIMARY KEY, minute INTEGER NOT NULL, minute_used INTEGER NOT NULL, day_used INTEGER NOT NULL);
