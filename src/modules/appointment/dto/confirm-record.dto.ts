/**
 * `POST /appointments/:id/confirm-record` 的请求体——**空 DTO**。
 *
 * 学生确认指导记录没有入参可收（「只能确认自己的」靠身份链判定），请求体出现
 * 任何字段一律 **400 / 10001**（全局 `forbidNonWhitelisted`，同
 * `CancelAppointmentDto` 的空白名单理由）。不许为了「先收着」把 `@Body()`
 * 写成 `Record<string, unknown>`。
 */
export class ConfirmRecordDto {}
