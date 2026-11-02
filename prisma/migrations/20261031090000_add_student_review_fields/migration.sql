-- P3 Task 33：学生评价（`StudentReview`）补 5 个业务列 + DB-11 唯一键。
--
-- 纯增量 DDL：只 ADD COLUMN / ADD UNIQUE KEY，没有任何 DROP 或数据改写。
--
-- 5 个新列**故意不给 DEFAULT**：这张表由 P3 首次引入，在所有环境里都是空的。
-- 无默认值意味着新行必须显式给值；有默认值反而会让「忘了传」静默落一个
-- 看似合法的枚举值（同 P2 台账 R44 对 `appointment_material.kind` 的裁定）。
--
-- `appointment_id_active` 是生成列：`deleted_at` 非空时取 NULL，MySQL 的唯一键
-- 不约束 NULL，于是「已软删的那条」不占位——同一预约被软删后可再评价（DB-11）。
--
-- 手写，勿让 `prisma migrate diff` 覆盖：Prisma 不建模生成列，diff 会想把它 DROP 掉
-- （与既有 `*_active` 列同样的坑，见 prisma/schema-contract.md）。

ALTER TABLE `student_review`
  ADD COLUMN `attitude` TINYINT NOT NULL,
  ADD COLUMN `expertise` TINYINT NOT NULL,
  ADD COLUMN `effect` TINYINT NOT NULL,
  ADD COLUMN `overall_score` DECIMAL(3, 2) NOT NULL,
  ADD COLUMN `comment` VARCHAR(1000) NULL,
  ADD COLUMN `appointment_id_active` BIGINT UNSIGNED
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `appointment_id`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_student_review_appointment_active` (`appointment_id_active`);
