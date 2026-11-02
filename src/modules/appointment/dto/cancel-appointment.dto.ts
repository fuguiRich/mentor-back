/**
 * `POST /appointments/:id/cancel` 的请求体——**空 DTO**。
 *
 * 取消没有入参可收（「只能取消自己的」靠身份链判定），请求体出现任何字段
 * 一律 **400 / 10001**（全局 `forbidNonWhitelisted`，同 `WithdrawApplicationDto`
 * 的空白名单理由）。不许为了「先收着」把 `@Body()` 写成 `Record<string, unknown>`。
 */
export class CancelAppointmentDto {}
