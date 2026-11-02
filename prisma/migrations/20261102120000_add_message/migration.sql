-- P5 Task 58：站内消息 / 提醒（§4.5）。
--
-- 纯新增表：只有 CREATE TABLE + CREATE INDEX，没有 DROP / 数据改写。
-- `recipient_user_id` 刻意不加外键：消息要活过账号软删，且收件人只在读路径
-- 按当前登录者过滤（与 `archive_item.mentor_id` 的裸列理由相同）。

CREATE TABLE `message` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `recipient_user_id` BIGINT UNSIGNED NOT NULL,
    `type` TINYINT NOT NULL,
    `title` VARCHAR(100) NOT NULL,
    `content` VARCHAR(500) NOT NULL,
    `biz_type` VARCHAR(50) NULL,
    `biz_id` VARCHAR(50) NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    INDEX `message_recipient_user_id_read_at_idx`(`recipient_user_id`, `read_at`),
    INDEX `message_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
