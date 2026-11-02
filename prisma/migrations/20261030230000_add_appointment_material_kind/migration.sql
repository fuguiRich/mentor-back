-- 预约材料分类（P2 / Task 29，返工轮 1 R39）。
--
-- 需求 §2.3：学生上传预约辅助材料，例子是「项目计划书、竞赛备赛资料」——
-- 材料需要自己的分类落点，否则前端传了 kind 也读不回来（R39 裁定：
-- 接受参数却不持久化是假接口）。
--
-- 取值：1 项目计划书 | 2 竞赛备赛资料 | 3 其他。与 Task 16 的
-- `mentor_application_material.kind`（1 职称证书 | 2 行业资质 | 3 其他）
-- 同型（TINYINT NOT NULL），但语义各自独立，不共用枚举。
--
-- `guidance_material` **不加**：需求 §3.5 只给了过程材料的例子
-- （课件、交流记录、项目修改意见），没有分类语义；两表不对称是有意为之。
--
-- 本文件是**纯增量**：只有一条 ADD COLUMN，零 DROP / DELETE / TRUNCATE，
-- 不回填、不动既有行，也不进任何索引 / 唯一键。表在 Task 20 建好后为空，
-- 因此 NOT NULL 无需默认值。

-- AlterTable：appointment_material 补材料分类
ALTER TABLE `appointment_material`
    ADD COLUMN `kind` TINYINT NOT NULL;
