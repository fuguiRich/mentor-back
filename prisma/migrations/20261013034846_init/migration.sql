-- 本文件有两处不能由 `prisma migrate dev` 自动生成，重生成迁移时会丢：
--   1. 所有 DATETIME(3) 的默认值为 (UTC_TIMESTAMP(3))，不是 CURRENT_TIMESTAMP(3)
--   2. 文件末尾的 6 个生成列与对应唯一索引（DB-11）
-- 若将来需要重新生成迁移，务必手工补回，否则「软删后同名可重建」会失效。

-- CreateTable
CREATE TABLE `sys_dept` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `parent_id` BIGINT UNSIGNED NULL,
    `name` VARCHAR(50) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE `sys_user` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(50) NOT NULL,
    `password` VARCHAR(100) NOT NULL,
    `real_name` VARCHAR(50) NOT NULL,
    `employee_no` VARCHAR(50) NOT NULL,
    `mobile` VARCHAR(20) NULL,
    `dept_id` BIGINT UNSIGNED NOT NULL,
    `status` TINYINT NOT NULL DEFAULT 1,
    `is_super_admin` BOOLEAN NOT NULL DEFAULT false,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    INDEX `sys_user_dept_id_idx`(`dept_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_role` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(50) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
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
CREATE TABLE `sys_permission` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `parent_id` BIGINT UNSIGNED NULL,
    `type` VARCHAR(10) NOT NULL,
    `code` VARCHAR(100) NULL,
    `name` VARCHAR(50) NOT NULL,
    `path` VARCHAR(200) NULL,
    `component` VARCHAR(200) NULL,
    `icon` VARCHAR(50) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `status` TINYINT NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_user_role` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `role_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,

    UNIQUE INDEX `sys_user_role_user_id_role_id_key`(`user_id`, `role_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sys_role_permission` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `role_id` BIGINT UNSIGNED NOT NULL,
    `permission_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,

    UNIQUE INDEX `sys_role_permission_role_id_permission_id_key`(`role_id`, `permission_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sys_dept` ADD CONSTRAINT `sys_dept_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `sys_dept`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_user` ADD CONSTRAINT `sys_user_dept_id_fkey` FOREIGN KEY (`dept_id`) REFERENCES `sys_dept`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_permission` ADD CONSTRAINT `sys_permission_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `sys_permission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_user_role` ADD CONSTRAINT `sys_user_role_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `sys_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_user_role` ADD CONSTRAINT `sys_user_role_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `sys_role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_role_permission` ADD CONSTRAINT `sys_role_permission_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `sys_role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_role_permission` ADD CONSTRAINT `sys_role_permission_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `sys_permission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 软删除表上的唯一约束必须排除已删除行（DB-11）。
-- 直接用 UNIQUE KEY(username)，已软删除的 zhangsan 会一直占着这个名字，
-- 新员工 zhangsan 永远建不进来，而管理员在界面上看不到任何同名记录。
ALTER TABLE `sys_dept`
  ADD COLUMN `name_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `name`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_dept_parent_name_active` (`parent_id`, `name_active`);

ALTER TABLE `sys_user`
  ADD COLUMN `username_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `username`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_user_username_active` (`username_active`),
  ADD COLUMN `employee_no_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `employee_no`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_user_employee_no_active` (`employee_no_active`),
  ADD COLUMN `mobile_active` VARCHAR(20)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `mobile`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_user_mobile_active` (`mobile_active`);

ALTER TABLE `sys_role`
  ADD COLUMN `code_active` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `code`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_role_code_active` (`code_active`);

ALTER TABLE `sys_permission`
  ADD COLUMN `code_active` VARCHAR(100)
    GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `code`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_sys_permission_code_active` (`code_active`);
