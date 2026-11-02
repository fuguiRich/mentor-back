import { CreateSlotDto } from './create-slot.dto';

/**
 * `PUT /mentor/slots/:id` 的请求体。
 *
 * **是整条替换，不是增量**：`weekday` / `startTime` / `endTime` 三个字段必填。
 *
 * `status` 与新建**语义不同**（这是继承之外唯一的差别，落在 Service 里）：
 * - 省略 → **保留原值**。导师把时段关掉后再改时间，不能被悄悄重新打开；
 *   默认值 1 只在新建时生效。
 * - `null` → 400 / 10001（`@IsOptional()` 会把 null 当没传，所以基类用的是
 *   `@ValidateIf(value !== undefined)`）。
 *
 * 为什么不用 `PartialType`（DTO-13 的常规做法）：`endTime > startTime` 是**跨字段**
 * 约束，只传其中一个字段时 DTO 层拿不到另一半，校验要么失效、要么被迫挪进 Service
 * （那样 400 的 `data.fields` 就点不到 `endTime`）。整条替换让跨字段校验留在 DTO 层，
 * 契约与错误形状都最直接。
 */
export class UpdateSlotDto extends CreateSlotDto {}
