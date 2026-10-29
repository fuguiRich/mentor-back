/**
 * `POST /mentor-applications`（提交入驻申请）的入参——**空 DTO**（brief §0.2）。
 *
 * 提交的语义是「把**当前档案**打包送审」，填报走 Task 11 的 `PUT /mentor/profile`。
 * 两处都收字段 = 两个写口写同一份数据，迟早分叉，所以这里一个字段都不认：
 * 请求体出现任何字段（含 `type` / `status` / `snapshot` / `personId`）一律
 * **400 / `PARAM_INVALID = 10001`**（全局 `forbidNonWhitelisted`，src/bootstrap.ts）。
 *
 * **不许**为绕开它把 `@Body()` 写成 `Record<string, unknown>`——那正是这张
 * 空白名单要挡的口子。`type` / `applicantId` / `profileId` / `snapshot` /
 * `status` 全部由服务端解析或定死（brief §2），入参一个都不收。
 */
export class SubmitOnboardDto {}
