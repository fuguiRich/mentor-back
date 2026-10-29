import { ApiProperty } from '@nestjs/swagger';
import { PermissionTreeResponseDto } from '../../permission/dto/permission-tree-response.dto';
import { UserDetailResponseDto } from '../../user/dto/user-detail-response.dto';

/**
 * 当前登录者的完整画像：我是谁 + 我能做什么 + 侧边栏摆什么。
 * 前端拿它一次渲染完，不必自己拿权限码拼菜单（spec 第 8 节）。
 */
export class AuthProfileResponseDto {
  @ApiProperty({
    type: () => UserDetailResponseDto,
    description: '当前用户（含已分配的角色 ID）',
  })
  user!: UserDetailResponseDto;

  @ApiProperty({
    type: [String],
    description:
      '当前用户可行使的权限码集合。超管返回系统里全部启用的权限码——' +
      '守卫对超管跳过检查，返回空集合会让前端把按钮全藏起来。',
    example: ['user:list', 'role:list'],
  })
  permissions!: string[];

  @ApiProperty({
    type: () => [PermissionTreeResponseDto],
    description:
      '裁剪后的菜单树（只有 DIR 与 MENU，BUTTON 不进侧边栏），前端直接渲染。',
  })
  menus!: PermissionTreeResponseDto[];
}
