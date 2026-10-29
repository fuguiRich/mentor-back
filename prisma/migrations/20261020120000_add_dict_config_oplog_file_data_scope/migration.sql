-- 本文件同样不能由 `prisma migrate dev` 生成，原因与 init 相同：
--   1. 所有 DATETIME(3) 的默认值为 (UTC_TIMESTAMP(3))，不是 CURRENT_TIMESTAMP(3)
--   2. 文件末尾的生成列与唯一索引（DB-11）
-- 另外：schema.prisma **不声明**生成列，所以 migrate dev 会把它们当漂移并试图删除。
-- 本项目走 `prisma migrate deploy`（package.json 的 db:migrate），不做漂移对账。

-- AlterTable：角色加数据范围
ALTER TABLE `sys_role` ADD COLUMN `data_scope` VARCHAR(20) NOT NULL DEFAULT 'self';

-- CreateTable
CREATE TABLE `sys_dict_type` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `status` TINYINT NOT NULL DEFAULT 1,
    `remark` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_dict_item` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `dict_type_id` BIGINT UNSIGNED NOT NULL,
    `label` VARCHAR(50) NOT NULL,
    `value` VARCHAR(50) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `status` TINYINT NOT NULL DEFAULT 1,
    `remark` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    INDEX `sys_dict_item_dict_type_id_idx`(`dict_type_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_config` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(100) NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `value` VARCHAR(500) NOT NULL,
    `value_type` VARCHAR(20) NOT NULL,
    `status` TINYINT NOT NULL DEFAULT 1,
    `remark` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- 操作日志 append-only：不设 deleted_at，也不给业务删改入口。
CREATE TABLE `sys_op_log` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `module` VARCHAR(50) NOT NULL,
    `action` VARCHAR(50) NOT NULL,
    `target_type` VARCHAR(50) NULL,
    `target_id` VARCHAR(50) NULL,
    `operator_name` VARCHAR(50) NOT NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(200) NOT NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `status` TINYINT NOT NULL DEFAULT 1,
    `error_code` INTEGER NULL,
    `error_msg` VARCHAR(500) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `duration_ms` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,

    INDEX `sys_op_log_created_by_idx`(`created_by`),
    INDEX `sys_op_log_module_idx`(`module`),
    INDEX `sys_op_log_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_file` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `origin_name` VARCHAR(255) NOT NULL,
    `storage_name` VARCHAR(100) NOT NULL,
    `ext` VARCHAR(20) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `size` INTEGER UNSIGNED NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    INDEX `sys_file_created_by_idx`(`created_by`),
    INDEX `sys_file_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sys_dict_item` ADD CONSTRAINT `sys_dict_item_dict_type_id_fkey` FOREIGN KEY (`dict_type_id`) REFERENCES `sys_dict_type`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 软删除表上的唯一约束必须排除已删除行（DB-11）。
-- 做法与 init 相同：VIRTUAL 生成列在 deleted_at 非空时取 NULL，
-- 而 MySQL 唯一索引允许多个 NULL，于是「删了旧的再建同名」不再撞约束。
ALTER TABLE `sys_dict_type`
  ADD COLUMN `code_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `code`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_dict_type_code_active` (`code_active`);

ALTER TABLE `sys_dict_item`
  ADD COLUMN `value_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `value`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_dict_item_type_value_active` (`dict_type_id`, `value_active`);

ALTER TABLE `sys_config`
  ADD COLUMN `code_active` VARCHAR(100)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `code`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_config_code_active` (`code_active`);
