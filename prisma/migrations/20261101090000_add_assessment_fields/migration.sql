-- P3 Task 37：考核（`assessment`）与考核申诉（`assessment_appeal`）落列。
--
-- 纯增量 DDL：只有 ADD COLUMN / ADD UNIQUE KEY / ADD INDEX，没有任何 DROP 或数据改写。
--
-- 两张表都由 P3 首次引入，在所有环境里都是空的，所以 NOT NULL 列**不给默认值**
-- （同 P2 台账 R44 / P3 台账对 `student_review` 的裁定）：无默认值意味着新行
-- 必须显式给值。例外是 `status`（两表都有 `DEFAULT 0`）——它是状态机的起点，
-- 「没写 status」与「status = 0 待处理」在这里语义相同，给默认值不会掩盖错误。
--
-- `mentor_period_active` 是生成列（DB-11）：`deleted_at` 非空时取 NULL，
-- MySQL 的唯一键不约束 NULL，于是「已软删的那条」不占位——
-- 同一导师同一周期删掉重来不会被唯一键挡死。
--
-- 手写，勿让 `prisma migrate diff` 覆盖：Prisma 不建模生成列。

ALTER TABLE `assessment`
  ADD COLUMN `period` VARCHAR(20) NOT NULL,
  ADD COLUMN `status` TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN `weights` JSON NULL,
  ADD COLUMN `review_avg` DECIMAL(3, 2) NULL,
  ADD COLUMN `review_count` INT UNSIGNED NULL,
  ADD COLUMN `guidance_count` INT UNSIGNED NULL,
  ADD COLUMN `guidance_minutes` INT UNSIGNED NULL,
  ADD COLUMN `student_count` INT UNSIGNED NULL,
  ADD COLUMN `achievement_count` INT UNSIGNED NULL,
  ADD COLUMN `composite_score` DECIMAL(5, 2) NULL,
  ADD COLUMN `college_grade` TINYINT NULL,
  ADD COLUMN `college_comment` VARCHAR(1000) NULL,
  ADD COLUMN `college_submitted_at` DATETIME(3) NULL,
  ADD COLUMN `college_submitted_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `final_grade` TINYINT NULL,
  ADD COLUMN `final_comment` VARCHAR(1000) NULL,
  ADD COLUMN `final_reviewed_at` DATETIME(3) NULL,
  ADD COLUMN `final_reviewed_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `mentor_period_active` VARCHAR(64)
    GENERATED ALWAYS AS (
      IF(`deleted_at` IS NULL, CONCAT(`mentor_id`, ':', `period`), NULL)
    ) VIRTUAL,
  ADD UNIQUE KEY `uk_assessment_mentor_period_active` (`mentor_period_active`),
  ADD INDEX `assessment_status_idx` (`status`);

ALTER TABLE `assessment_appeal`
  ADD COLUMN `reason` VARCHAR(1000) NOT NULL,
  ADD COLUMN `status` TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN `reply` VARCHAR(1000) NULL,
  ADD COLUMN `handled_at` DATETIME(3) NULL,
  ADD COLUMN `handled_by` BIGINT UNSIGNED NULL;
