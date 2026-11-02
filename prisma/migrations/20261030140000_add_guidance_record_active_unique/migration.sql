-- DB-11：软删表上的唯一约束必须排除已删行。
--
-- 与 `sys_user.username_active` / `sys_dept.name_active` 同一模式：生成列在
-- `deleted_at` 非空时取 NULL，MySQL 的唯一键不约束 NULL，于是「已软删的那条」不占位。
--
-- 上一份迁移（`20261030120000_add_appointment_domain`）曾把唯一键直接建在
-- `appointment_id` 业务列上（普通唯一键）。那在软删表上违反 DB-11：删掉一条指导记录后，
-- 同一预约将永远无法再建记录。这里先摘掉那把不合规的唯一键，再换成生成列唯一键。
--
-- 手写，勿让 `prisma migrate diff` 覆盖：Prisma 不建模生成列，diff 会想把它 DROP 掉
-- （与既有 `*_active` 列同样的坑，见 prisma/schema-contract.md）。

-- 摘掉建在业务列上的普通唯一键（它会把已软删的行也算进唯一性）
DROP INDEX `guidance_record_appointment_id_key` ON `guidance_record`;

ALTER TABLE `guidance_record`
  ADD COLUMN `appointment_id_active` BIGINT UNSIGNED
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `appointment_id`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_guidance_record_appointment_active` (`appointment_id_active`);
