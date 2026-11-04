ALTER TABLE `sys_user`
  ADD COLUMN `auth_source` VARCHAR(20) NOT NULL DEFAULT 'local';

UPDATE `sys_user` u
JOIN `sync_person` p
  ON p.`login` = u.`username` AND p.`deleted_at` IS NULL
SET u.`auth_source` = 'sso'
WHERE p.`person_type` IN ('internalMentor', 'teacher', 'student')
  AND u.`is_super_admin` = 0
  AND u.`deleted_at` IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `sys_user_role` ur
    JOIN `sys_role` r ON r.`id` = ur.`role_id`
    WHERE ur.`user_id` = u.`id`
      AND r.`code` IN ('college_admin', 'sc_admin')
  );

ALTER TABLE `sync_run`
  ADD COLUMN `mode` VARCHAR(20) NULL;
