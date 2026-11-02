-- DB-11：软删表上的唯一约束必须排除已删行。
--
-- 预约材料 / 过程材料的「同一 fileId 不重复挂」原先只有服务层的「先查后插」
-- （hasActiveAppointmentMaterial / hasActiveGuidanceMaterial）。两个并发请求可以
-- 都查到 0 行、都插入成功，落下两行重复。唯一键是并发兜底。
--
-- 与 `sys_user.username_active` / `guidance_record.appointment_id_active` 同一模式：
-- 生成列在 `deleted_at` 非空时取 NULL，MySQL 的唯一键不约束 NULL，于是「已软删的
-- 那条」不占位——摘掉后同一 fileId 允许再挂。
--
-- 手写，勿让 `prisma migrate diff` 覆盖：Prisma 不建模生成列，diff 会想把它 DROP 掉
-- （与既有 `*_active` 列同样的坑，见 prisma/schema-contract.md）。
--
-- 纯增量：只有 ADD COLUMN / ADD UNIQUE KEY，零 DROP TABLE / DROP COLUMN / DELETE / TRUNCATE。
--
-- 列名说明：`GuidanceMaterial.recordId` 在库里映射到 `guidance_record_id`
-- （Task 5 占位期的列名，见 schema-contract.md），不是 `record_id`。

ALTER TABLE `appointment_material`
  ADD COLUMN `appointment_file_active` VARCHAR(64)
    GENERATED ALWAYS AS (
      IF(`deleted_at` IS NULL, CONCAT(`appointment_id`, ':', `file_id`), NULL)
    ) VIRTUAL,
  ADD UNIQUE KEY `uk_appointment_material_file_active` (`appointment_file_active`);

ALTER TABLE `guidance_material`
  ADD COLUMN `record_file_active` VARCHAR(64)
    GENERATED ALWAYS AS (
      IF(`deleted_at` IS NULL, CONCAT(`guidance_record_id`, ':', `file_id`), NULL)
    ) VIRTUAL,
  ADD UNIQUE KEY `uk_guidance_material_file_active` (`record_file_active`);
