import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionService } from './permission.service';
import { PermissionParamDto } from './dto/permission-param.dto';
import { PermissionResponseDto } from './dto/permission-response.dto';
import { PermissionTreeResponseDto } from './dto/permission-tree-response.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

@ApiTags('权限菜单')
@Controller('permissions')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  // tree 必须声明在 :id 之前（同 dept.controller.ts 的说明）
  @Get('tree')
  @RequirePermission('permission:list')
  @ApiOperation({
    summary: '查询权限点树',
    description:
      '权限点管理页的主视图。返回全部未删除权限点（含停用的——管理页要能看见并启用它们），' +
      '按父子关系组装成树，同级按 sortOrder 升序。' +
      '本接口**不过滤**登录者可见性：它是管理接口，不是给前端渲染侧边栏用的' +
      '（侧边栏走 GET /auth/profile 的菜单树）。',
  })
  @ApiOkResponse({
    type: [PermissionTreeResponseDto],
    description: '查询成功，返回权限点层级树；没有任何权限点时为 []',
  })
  @ApiInternalServerErrorResponse({
    description: '数据异常：权限点数据存在环，无法构建权限树',
    schema: {
      example: errExample(
        ErrorCode.INTERNAL_ERROR,
        '权限点数据存在环，无法构建权限树',
      ),
    },
  })
  async findTree(): Promise<PermissionTreeResponseDto[]> {
    return this.permissionService.findTree();
  }

  @Get(':id')
  @RequirePermission('permission:list')
  @ApiOperation({
    summary: '查询权限点详情',
    description:
      '权限点详情页、编辑表单回填时调用。' +
      '已软删除的权限点视同不存在，一律返回 404，不区分「从未存在」与「已删除」。',
  })
  @ApiOkResponse({
    type: PermissionResponseDto,
    description: '查询成功，返回该权限点的完整字段',
  })
  @ApiNotFoundResponse({
    description: '权限点不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.PERMISSION_NOT_FOUND, '权限点不存在'),
    },
  })
  async findOne(
    @Param() params: PermissionParamDto,
  ): Promise<PermissionResponseDto> {
    return this.permissionService.findOne(BigInt(params.id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('permission:create')
  @ApiOperation({
    summary: '新增权限点',
    description:
      '新建一个权限点。type 决定 code 的必填性：DIR 不能带码（它只是前端菜单分组），' +
      'MENU / BUTTON 必须带码（@RequirePermission 就是拿这个码比对的）。' +
      '违反这条回 23103 / 23104。权限码全局唯一。',
  })
  @ApiCreatedResponse({
    type: PermissionResponseDto,
    description: '创建成功，返回新建的权限点记录',
  })
  @ApiConflictResponse({
    description: '权限码已存在',
    schema: {
      example: errExample(ErrorCode.PERMISSION_CODE_TAKEN, '权限码已存在'),
    },
  })
  async create(
    @Body() dto: CreatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.permissionService.create(dto);
  }

  @Put(':id')
  @RequirePermission('permission:update')
  @ApiOperation({
    summary: '修改权限点',
    description:
      '修改权限点。name 必填——PUT 是全量替换语义；其余字段只传要改的，未传的保持原值。' +
      'parentId 显式传 null 表示提升为根节点；code 显式传 null 表示清空。' +
      '改动之后类型与码的关系仍须成立（把 MENU 改成 DIR 时要连 code: null 一起传），' +
      '否则回 23103 / 23104。sortOrder / status 显式传 null 会返回 400。',
  })
  @ApiOkResponse({
    type: PermissionResponseDto,
    description: '修改成功，返回修改后的权限点记录',
  })
  @ApiNotFoundResponse({
    description: '权限点不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.PERMISSION_NOT_FOUND, '权限点不存在'),
    },
  })
  async update(
    @Param() params: PermissionParamDto,
    @Body() dto: UpdatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.permissionService.update(BigInt(params.id), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @RequirePermission('permission:delete')
  @ApiOperation({
    summary: '删除权限点（软删除）',
    description:
      '删除一个权限点。删除是打标记而非物理删除，数据行保留以便追溯；' +
      '同一事务里会**物理清掉**角色对它的引用——不清就会留下悬挂引用。' +
      '这带来一个必须写明的语义：删一个权限点等于把它从所有角色上摘掉（fail-closed，' +
      '少一个权限，不会多一个）。存在未删除的下级时拒绝删除（23106），' +
      '避免一次点击让菜单结构变样。',
  })
  @ApiNoContentResponse({ description: '删除成功，响应体为空' })
  @ApiConflictResponse({
    description: '该权限点下还有下级',
    schema: {
      example: errExample(
        ErrorCode.PERMISSION_HAS_CHILDREN,
        '该权限点下还有 2 个下级，请先移走或删除',
      ),
    },
  })
  async remove(@Param() params: PermissionParamDto): Promise<void> {
    await this.permissionService.remove(BigInt(params.id));
  }
}
