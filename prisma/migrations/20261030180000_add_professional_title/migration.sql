-- Task 20c（R28）：MentorProfile 补「职称 / 资质」字段。
--
-- 纯增量：一条 ALTER TABLE ADD COLUMN，可 NULL，**不回填、不动既有行**。
-- 不进唯一键，不需要 DB-11 生成列（唯一性仍只在 person_id_active 上）。
-- 自由文本 ≤100（DTO 约束），不是字典 / 枚举；内校 / 外校都填（不置 NULL）。
-- schema.prisma 与本迁移一起改（改名 = 违反契约；加列可以）。

-- AddField
ALTER TABLE `mentor_profile` ADD COLUMN `professional_title` VARCHAR(100) NULL;
