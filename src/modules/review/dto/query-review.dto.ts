import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * `GET /mentors/:mentorId/reviews` 的查询参数（DTO-02：query 独立 DTO）。
 *
 * 只继承分页。**没有 `keyword` / `minScore` 之类的筛选项**——需求 §2.5 只说
 * 「支持评分 + 文字评价」，评价页按时间倒序翻页就够了；多一个筛选就多一套
 * 前端状态，等有人真的提出来再加。
 */
export class QueryReviewDto extends PaginationQueryDto {}
