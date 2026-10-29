-- 同步行的出处列（Ruling 16）。纯增量，不动已有行。
--
-- 为什么是独立一条而不是塞进 20261027120000：那条已经应用到本地两个库上了，
-- 而「已应用的迁移不改」是硬规矩——改了 Prisma 的 checksum 就对不上，
-- `migrate status` / `migrate deploy` 会一直报「迁移文件被改过」。
-- 要合成一条，得 reset 两个库重来，而这里只需要加两列。
--
-- 为什么**没有** FOREIGN KEY：出处是留痕不是归属。SyncRun 按保留期清掉时，
-- 同步行必须活下来；挂了外键就等于永远不许清流水（同
-- `mentor_application_material.file_id` 的先例）。

ALTER TABLE `sync_org_unit`
  ADD COLUMN `sync_run_id` BIGINT UNSIGNED NULL AFTER `synced_at`,
  ADD INDEX `sync_org_unit_sync_run_id_idx` (`sync_run_id`);

ALTER TABLE `sync_person`
  ADD COLUMN `sync_run_id` BIGINT UNSIGNED NULL AFTER `synced_at`,
  ADD INDEX `sync_person_sync_run_id_idx` (`sync_run_id`);
