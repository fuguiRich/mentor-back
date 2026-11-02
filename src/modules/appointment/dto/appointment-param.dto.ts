import { ApiProperty } from '@nestjs/swagger';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * 预约类路由的路径参数（Task 24 / 25 / 26 / 27）：
 * `POST /appointments/:id/{confirm,reject,reschedule,cancel,confirm-record,dispute,record}`
 * 与 `GET /appointments/:id/record`。
 *
 * `:id` 是 `Appointment.id`，库列 BIGINT UNSIGNED、对外一律字符串；
 * 校验用 `@IsBigIntId()`（`1.5` / `-1` / `+1` 与超界都挡在 400，不进 `BigInt()`）。
 */
export class AppointmentParamDto {
  @ApiProperty({
    description: '预约行 ID（BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '预约 ID 必须是合法的数字 ID' })
  id!: string;
}
