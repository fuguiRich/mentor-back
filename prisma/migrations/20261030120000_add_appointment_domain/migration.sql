-- 预约域建模（P2 / Task 20）。
--
-- 五张表在 `20261027120000_add_sync_layer_and_mentor_domain` 里已经建出骨架
-- （id / 审计四列 / 软删两列 / 外键），这里只补 P2 的业务列、复合索引与唯一键，
-- 并给 appointment 挂上可空的 slot_id。
--
-- 这份 DDL 由 `prisma migrate diff` 生成后**手工修剪**，与上一份迁移同样的两处看住：
--   1. 不要保留 diff 给出的 `MODIFY created_at/updated_at DEFAULT CURRENT_TIMESTAMP(3)`——
--      那是 Prisma 认不出 `(UTC_TIMESTAMP(3))` 的假漂移，改了就不再存 UTC。
--   2. 不要保留 diff 对 `*_active` 生成列给出的 DROP——DB-11 的唯一性靠它们。
-- 因此本文件**零 DROP**：只有 ADD COLUMN / CREATE INDEX / ADD CONSTRAINT。
--
-- 占位期的单列索引（`appointment_mentor_id_idx` 等）保留：复合索引虽已覆盖其前缀，
-- 但删它们会产生 DROP INDEX，与本次「纯增量迁移」的约束冲突。
--
-- 五张表此刻均为空表（P2 尚未写入），故新增 NOT NULL 列不带默认值是安全的。

-- AlterTable：mentor_time_slot 补业务列
ALTER TABLE `mentor_time_slot`
    ADD COLUMN `weekday` TINYINT NOT NULL,
    ADD COLUMN `start_time` VARCHAR(5) NOT NULL,
    ADD COLUMN `end_time` VARCHAR(5) NOT NULL,
    ADD COLUMN `status` TINYINT NOT NULL DEFAULT 1;

-- AlterTable：appointment 补业务列
ALTER TABLE `appointment`
    ADD COLUMN `type` TINYINT NOT NULL,
    ADD COLUMN `status` TINYINT NOT NULL DEFAULT 0,
    ADD COLUMN `requested_time` DATETIME(3) NOT NULL,
    ADD COLUMN `proposed_time` DATETIME(3) NULL,
    ADD COLUMN `topic` VARCHAR(200) NOT NULL,
    ADD COLUMN `reject_reason` VARCHAR(500) NULL,
    ADD COLUMN `slot_id` BIGINT UNSIGNED NULL;

-- AlterTable：guidance_record 补业务列
ALTER TABLE `guidance_record`
    ADD COLUMN `content` TEXT NOT NULL,
    ADD COLUMN `submitted_by` BIGINT UNSIGNED NOT NULL,
    ADD COLUMN `submitted_at` DATETIME(3) NOT NULL;

-- CreateIndex
CREATE INDEX `mentor_time_slot_mentor_id_weekday_idx` ON `mentor_time_slot`(`mentor_id`, `weekday`);

-- CreateIndex：预约列表按「导师 / 学生 + 状态」过滤，另按状态扫超时（Task 25 / 30）
CREATE INDEX `appointment_mentor_id_status_idx` ON `appointment`(`mentor_id`, `status`);
CREATE INDEX `appointment_student_id_status_idx` ON `appointment`(`student_id`, `status`);
CREATE INDEX `appointment_status_idx` ON `appointment`(`status`);
CREATE INDEX `appointment_slot_id_idx` ON `appointment`(`slot_id`);

-- CreateIndex：一条预约只能一条指导记录（Task 26 重复提交 409 的兜底）
CREATE UNIQUE INDEX `guidance_record_appointment_id_key` ON `guidance_record`(`appointment_id`);

-- AddForeignKey：时段可空（预约可以不带时段）
ALTER TABLE `appointment` ADD CONSTRAINT `appointment_slot_id_fkey` FOREIGN KEY (`slot_id`) REFERENCES `mentor_time_slot`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
