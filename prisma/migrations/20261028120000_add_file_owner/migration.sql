-- 文件归属：证明「这个文件是这条业务记录的附件」（Task 8）。
--
-- 为什么是裸列不挂外键：owner_type 是业务模块的类型名（如 'MentorApplication'），
-- 目标表因业务而异，通用文件模块不认得也不该认得——挂外键就等于让 sys_file
-- 认识每一张业务表。归属校验在 assertOwnedBy 里做，不在 DDL 里做。
--
-- 为什么两列都可 NULL：不带归属的上传是现状（通用文件管理面），必须继续可用。
-- 空 = 无归属的通用文件；给了就是成对给（校验在服务层，见 file.service.ts）。
--
-- 纯增量：不回填、不动既有行、不进任何唯一键。
ALTER TABLE `sys_file`
  ADD COLUMN `owner_type` VARCHAR(50) NULL AFTER `sha256`,
  ADD COLUMN `owner_id` BIGINT UNSIGNED NULL AFTER `owner_type`;
