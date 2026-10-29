-- 示例业务表（mentor-back）。**看完就删**：连同 src/modules/demo/ 与
-- schema.prisma 里的 model DemoNote 一起去掉，就回到干净状态。
--
-- 两处不能由 `prisma migrate dev` 生成，重生成迁移时会丢：
--   1. DATETIME(3) 的默认值是 (UTC_TIMESTAMP(3))，不是 CURRENT_TIMESTAMP(3)
--      ——本工程的时间一律存 UTC，用 CURRENT_TIMESTAMP 会按服务器时区写进去
--   2. 若这张表需要「软删后同名重建」的唯一键，必须手写生成列 + 唯一索引
--      （见 prisma/schema-contract.md 的 DB-11），
--      Prisma 的 schema.prisma 表达不了生成列

-- CreateTable
CREATE TABLE `demo_note` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(100) NOT NULL,
    `content` TEXT NULL,
    `status` TINYINT NOT NULL DEFAULT 1,
    `dept_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    INDEX `demo_note_dept_id_idx`(`dept_id`),
    INDEX `demo_note_created_by_idx`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
