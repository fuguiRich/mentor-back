INSERT INTO `sys_role`
  (`name`, `code`, `data_scope`, `status`, `remark`, `created_at`, `updated_at`, `created_by`, `updated_by`)
SELECT
  '超级管理员', 'super_admin', 'all', 1, '内置角色', NOW(3), NOW(3), 0, 0
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `sys_role`
  WHERE `code` = 'super_admin' AND `deleted_at` IS NULL
);

INSERT IGNORE INTO `sys_user_role`
  (`user_id`, `role_id`, `created_at`, `updated_at`, `created_by`, `updated_by`)
SELECT
  u.`id`, r.`id`, NOW(3), NOW(3), 0, 0
FROM `sys_user` u
JOIN `sys_role` r
  ON r.`code` = 'super_admin' AND r.`deleted_at` IS NULL
WHERE u.`is_super_admin` = 1 AND u.`deleted_at` IS NULL;

UPDATE `sys_user` u
JOIN `sys_user_role` ur ON ur.`user_id` = u.`id`
JOIN `sys_role` r ON r.`id` = ur.`role_id`
SET u.`is_super_admin` = 1
WHERE r.`code` = 'super_admin'
  AND r.`deleted_at` IS NULL
  AND u.`deleted_at` IS NULL
  AND u.`is_super_admin` = 0;