-- 投影映射：sync_org_unit 的每一行投影出哪一条 sys_dept（见 Ruling 22）。
--
-- 为什么要有这一列：`sys_dept` 的自然键是 `(parent_id, name_active)`，名字不是
-- 稳定键。源系统把学院改名，按名字配行就会当成「旧的没了 + 新的来了」——软删旧
-- 部门、新建一个，而 `sys_user.dept_id` 全指向那条软删行，数据权限当场失效。
--
-- 为什么是裸列不挂外键：与 `sync_run_id` 同一先例（见
-- `20261027130000_add_sync_run_id/migration.sql`）。出处 / 映射是留痕不是归属，
-- `sys_dept` 被清掉时同步行必须活下来。
--
-- 为什么单独一条迁移：`20261027120000` 与 `20261027130000` 已经应用到本地两个库上，
-- 已应用的迁移不许改（Prisma 的 checksum 会对不上）。纯增量 `ADD COLUMN` 是安全的。
ALTER TABLE `sync_org_unit`
  ADD COLUMN `dept_id` BIGINT UNSIGNED NULL AFTER `sync_run_id`,
  ADD INDEX `sync_org_unit_dept_id_idx` (`dept_id`);
