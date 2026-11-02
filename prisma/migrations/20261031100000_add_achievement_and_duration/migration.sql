-- P3 Task 35：双创成果（`achievement`）落列 + 指导记录补 `duration_minutes`。
--
-- 纯增量 DDL：只有 ADD COLUMN / ADD INDEX，没有任何 DROP 或数据改写。
--
-- `guidance_record.duration_minutes` 给 **DEFAULT 0**，与 `student_review` /
-- `achievement` 的新列不同：这张表**已经有数据**（P2 提交过的记录），
-- 不给默认值会让迁移在严格模式下直接失败。`0` 的语义是「导师未填」，
-- 不是「零分钟」——P2 的提交 DTO 没有这个字段，存量行本来就无从得知时长。
--
-- `achievement` 的 4 个 NOT NULL 列**不给默认值**：该表由 P3 首次引入，
-- 在所有环境里都是空的；无默认值意味着新行必须显式给值（同 P2 台账 R44）。
--
-- 手写，勿让 `prisma migrate diff` 覆盖。

ALTER TABLE `guidance_record`
  ADD COLUMN `duration_minutes` INT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE `achievement`
  ADD COLUMN `type` TINYINT NOT NULL,
  ADD COLUMN `title` VARCHAR(200) NOT NULL,
  ADD COLUMN `level` TINYINT NOT NULL,
  ADD COLUMN `awarded_at` DATE NOT NULL,
  ADD COLUMN `description` VARCHAR(1000) NULL,
  ADD COLUMN `proof_file_id` BIGINT UNSIGNED NULL,
  ADD INDEX `achievement_awarded_at_idx` (`awarded_at`);
