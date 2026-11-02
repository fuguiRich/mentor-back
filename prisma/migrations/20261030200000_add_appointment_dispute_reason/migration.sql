-- 学生异议原因（P2 / Task 27）。
--
-- 需求 §2.4：学生核对指导记录后「有异议填写反馈申请复核」。异议原因需要一个
-- 自己的落点——`reject_reason` 是导师拒绝预约的原因，`handle_comment` 是导师
-- 处理时的意见，两者语义都不同，不能复用。
--
-- 本文件由 `prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ...`
-- 生成后**手工修剪**，只保留真正的增量：
--   1. 去掉 diff 给出的 `MODIFY created_at/updated_at DEFAULT CURRENT_TIMESTAMP(3)`——
--      那是 Prisma 认不出 `(UTC_TIMESTAMP(3))` 的假漂移，改了就不再存 UTC。
--   2. 去掉 diff 对 `*_active` 生成列与其唯一键给出的 DROP——DB-11 的唯一性靠它们。
--   3. 去掉 diff 对既有外键 / 索引重排的 DROP / ADD——它们与本次改表无关。
-- 因此本文件**零 DROP / DELETE / TRUNCATE**，只有一条 ADD COLUMN（纯增量）。

-- AlterTable：appointment 补学生异议原因
ALTER TABLE `appointment`
    ADD COLUMN `dispute_reason` VARCHAR(500) NULL;
