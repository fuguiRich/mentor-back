-- 管理员异议复核意见（P2 / Task 28）。
--
-- 需求 §4.3：二级学院管理员审核「学生预约复核申请」，「可选择通过 / 不通过；
-- 不通过需填写审核意见」。复核意见需要一个自己的落点——
-- `handle_comment` 是导师处理预约时的意见，`reject_reason` 是导师拒绝预约的原因，
-- `dispute_reason` 是学生提异议的原因，三者语义都不同，不能复用。
--
-- 本文件是**纯增量**：只有一条 ADD COLUMN，零 DROP / DELETE / TRUNCATE，
-- 不回填、不动既有行，也不进任何索引 / 唯一键。
-- 与 Task 27 的 `dispute_reason` 同法（VARCHAR(500) NULL）。

-- AlterTable：appointment 补管理员异议复核意见
ALTER TABLE `appointment`
    ADD COLUMN `adjudicate_comment` VARCHAR(500) NULL;
