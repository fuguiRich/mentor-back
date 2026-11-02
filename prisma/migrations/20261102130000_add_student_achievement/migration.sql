-- P5 Task 59：学生双创成果 + 人工关联（§5.4）。
--
-- 纯新增表：CREATE TABLE + 索引 + 外键，没有 DROP / 数据改写。
-- `mentor_id` / `achievement_id` 可空：先建成果、后关联；关联时同一事务
-- 生成导师 `achievement` 并回填 `achievement_id`（一条成果只对应一条学生成果）。

CREATE TABLE `student_achievement` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `student_person_id` BIGINT UNSIGNED NOT NULL,
    `mentor_id` BIGINT UNSIGNED NULL,
    `achievement_id` BIGINT UNSIGNED NULL,
    `dept_id` BIGINT UNSIGNED NULL,
    `type` TINYINT NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `level` TINYINT NOT NULL,
    `awarded_at` DATE NOT NULL,
    `proof_file_id` BIGINT UNSIGNED NULL,
    `linked_at` DATETIME(3) NULL,
    `linked_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `updated_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `student_achievement_achievement_id_key`(`achievement_id`),
    INDEX `student_achievement_student_person_id_idx`(`student_person_id`),
    INDEX `student_achievement_mentor_id_idx`(`mentor_id`),
    INDEX `student_achievement_dept_id_idx`(`dept_id`),
    INDEX `student_achievement_awarded_at_idx`(`awarded_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `student_achievement`
  ADD CONSTRAINT `student_achievement_student_person_id_fkey`
    FOREIGN KEY (`student_person_id`) REFERENCES `sync_person`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `student_achievement`
  ADD CONSTRAINT `student_achievement_mentor_id_fkey`
    FOREIGN KEY (`mentor_id`) REFERENCES `mentor_profile`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `student_achievement`
  ADD CONSTRAINT `student_achievement_achievement_id_fkey`
    FOREIGN KEY (`achievement_id`) REFERENCES `achievement`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
