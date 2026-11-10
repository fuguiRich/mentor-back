ALTER TABLE `archive_item`
  ADD COLUMN `file_ids` JSON NULL;

ALTER TABLE `assessment_appeal`
  ADD COLUMN `file_ids` JSON NULL;