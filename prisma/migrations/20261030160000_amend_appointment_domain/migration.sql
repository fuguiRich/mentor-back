-- 预约域建模补列（P2 / Task 20b）。
--
-- 原始需求清单（§2.2 / §3.4，R25 / R26）到位后，补齐 Task 20「推断版」契约缺的七列。
-- 这份 DDL 由 `prisma migrate diff` 生成后**手工修剪**，与既有迁移同样的三处看住：
--   1. 不要保留 diff 给出的 `MODIFY created_at/updated_at DEFAULT CURRENT_TIMESTAMP(3)`——
--      那是 Prisma 认不出 `(UTC_TIMESTAMP(3))` 的假漂移，改了就不再存 UTC。
--   2. 不要保留 diff 对 `*_active` 生成列给出的 DROP / DROP INDEX——DB-11 的唯一性靠它们。
--   3. 不要保留 diff 对 `content` 给出的 `DROP COLUMN` + `ADD COLUMN core_content`——
--      Prisma 不识别改名，这里改写成 `RENAME COLUMN`，语义连续且零 DROP。
-- 因此本文件**零 DROP TABLE / DROP COLUMN / DELETE / TRUNCATE**：
-- 只有 ADD COLUMN / RENAME COLUMN。
--
-- 五张表此刻均为空表（已核对 COUNT(*) = 0），故新增 NOT NULL 列不带默认值是安全的。

-- AlterTable：appointment 补 §2.2 的预约填报字段
ALTER TABLE `appointment`
    ADD COLUMN `questions` TEXT NOT NULL,
    ADD COLUMN `mode` TINYINT NOT NULL,
    ADD COLUMN `handle_comment` VARCHAR(500) NULL;

-- AlterTable：guidance_record 补 §3.4 的指导记录字段；
-- 原 `content` 就是「核心指导内容」，改名为 `core_content`（RENAME，不新增同义列）
ALTER TABLE `guidance_record`
    RENAME COLUMN `content` TO `core_content`;

ALTER TABLE `guidance_record`
    ADD COLUMN `actual_time` DATETIME(3) NOT NULL,
    ADD COLUMN `mode` TINYINT NOT NULL,
    ADD COLUMN `follow_up` TEXT NOT NULL;
