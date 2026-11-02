-- P4 Task 51：归档条目（`archive_item`）补 8 个业务列 + DB-11 复合生成列唯一键。
--
-- 纯增量 DDL：只有 ADD COLUMN / ADD UNIQUE KEY / ADD INDEX，没有任何 DROP 或数据改写。
--
-- 该表由 P4 首次引入，在所有环境里都是空的，所以 NOT NULL 列**不给默认值**
-- （`core` 例外：默认 1「核心」——「没写 core」与「是核心材料」语义相同，
-- 而 §4.7 要求「长期保存」，往紧的方向取才对）。
--
-- `target_active` 是生成列：`deleted_at` 非空时取 NULL，MySQL 的唯一键不约束 NULL，
-- 于是「取消归档后可以再归档同一条记录」（DB-11）。
--
-- 手写，勿让 `prisma migrate diff` 覆盖：Prisma 不建模生成列。

ALTER TABLE `archive_item`
  ADD COLUMN `title` VARCHAR(200) NOT NULL,
  ADD COLUMN `mentor_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `dept_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `category` VARCHAR(50) NOT NULL,
  ADD COLUMN `core` TINYINT NOT NULL DEFAULT 1,
  ADD COLUMN `archived_at` DATETIME(3) NOT NULL,
  ADD COLUMN `retention_until` DATE NULL,
  ADD COLUMN `summary` VARCHAR(500) NULL,
  ADD COLUMN `target_active` VARCHAR(120)
    GENERATED ALWAYS AS (
      IF(`deleted_at` IS NULL, CONCAT(`target_type`, ':', `target_id`), NULL)
    ) VIRTUAL,
  ADD UNIQUE KEY `uk_archive_item_target_active` (`target_active`),
  ADD INDEX `archive_item_mentor_id_idx` (`mentor_id`),
  ADD INDEX `archive_item_category_idx` (`category`),
  ADD INDEX `archive_item_retention_until_idx` (`retention_until`);
