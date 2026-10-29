-- Task 11 / 12：MentorProfile 补全填报字段。
--
-- 纯增量：五条 ALTER TABLE ADD COLUMN，全部可 NULL，**不回填、不动既有行**。
-- 不进唯一键，不需要 DB-11 生成列（唯一性仍只在 person_id_active 上）。
-- schema.prisma 与本迁移一起改（改名 = 违反契约；加列可以）。

-- AddField
ALTER TABLE `mentor_profile` ADD COLUMN `summary` TEXT NULL;

-- AddField
ALTER TABLE `mentor_profile` ADD COLUMN `achievements` TEXT NULL;

-- AddField
ALTER TABLE `mentor_profile` ADD COLUMN `guidance_experience` TEXT NULL;

-- AddField
ALTER TABLE `mentor_profile` ADD COLUMN `affiliate_org` VARCHAR(100) NULL;

-- AddField
ALTER TABLE `mentor_profile` ADD COLUMN `social_roles` VARCHAR(100) NULL;
