import { Body, Controller, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Endpoint } from '../../../../common/decorators/endpoint.decorator';
import { CurrentPrincipal } from '../../../../common/decorators/principal.decorator';
import { OperationKey } from '../../../../common/decorators/operation-key.decorator';
import { SessionGuard } from '../../../../common/guards/session.guard';
import { ZodValidationPipe } from '../../../../common/http/zod-validation.pipe';
import { Principal } from '../../../../common/types/principal';
import { JsonResponse } from '../../../../common/types/http';
import { emptyBodySchema } from '../../../identity/dto/login.dto';
import {
  EndWorkdayDto,
  endWorkdaySchema,
  StartWorkdayDto,
  startWorkdaySchema,
  workdayResponseSchema,
} from '../dto/workday.dto';
import {
  EndPauseDto,
  endPauseSchema,
  pauseReasonResponseSchema,
  StartPauseDto,
  startPauseSchema,
  workdayPauseResponseSchema,
} from '../dto/pause.dto';
import { WorkdaysService } from '../services/workdays.service';
import { pageResultSchema, PaginationQuery, paginationQuerySchema } from '../../../../common/pagination';

@Controller('v1/me')
@UseGuards(SessionGuard)
export class WorkdaysController {
  constructor(private readonly workdays: WorkdaysService) {}

  @Endpoint({
    method: 'get',
    path: 'workday',
    output: workdayResponseSchema.nullable(),
  })
  async current(
    @CurrentPrincipal() principal: Principal,
    @Res() response: JsonResponse,
  ): Promise<void> {
    response.json(await this.workdays.current(principal));
  }

  @Endpoint({
    method: 'get',
    path: 'workday-policy',
    output: z.object({ cutoff_hour: z.string(), time_zone: z.string() }),
  })
  policy(@CurrentPrincipal() principal: Principal) {
    return this.workdays.policy(principal);
  }

  @Endpoint({
    method: 'get',
    path: 'workdays',
    query: paginationQuerySchema,
    output: pageResultSchema(workdayResponseSchema),
  })
  list(@CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(paginationQuerySchema)) filters: PaginationQuery) {
    return this.workdays.list(principal, filters);
  }

  @Endpoint({
    method: 'post',
    path: 'workdays/start',
    input: startWorkdaySchema,
    output: workdayResponseSchema,
    operationKey: true,
  })
  start(
    @CurrentPrincipal() principal: Principal,
    @OperationKey() key: string,
    @Body(new ZodValidationPipe(startWorkdaySchema)) input: StartWorkdayDto,
  ) {
    return this.workdays.start(principal, key, input);
  }

  @Endpoint({
    method: 'post',
    path: 'workdays/end',
    input: endWorkdaySchema,
    output: workdayResponseSchema,
    operationKey: true,
  })
  end(
    @CurrentPrincipal() principal: Principal,
    @OperationKey() key: string,
    @Body(new ZodValidationPipe(endWorkdaySchema)) input: EndWorkdayDto,
  ) {
    return this.workdays.end(principal, key, input);
  }

  @Endpoint({
    method: 'get',
    path: 'pause-reasons',
    output: z.array(pauseReasonResponseSchema),
  })
  listPauseReasons(@CurrentPrincipal() principal: Principal) {
    return this.workdays.listPauseReasons(principal);
  }

  @Endpoint({
    method: 'get',
    path: 'workday/pause',
    output: workdayPauseResponseSchema.nullable(),
  })
  async currentPause(
    @CurrentPrincipal() principal: Principal,
    @Res() response: JsonResponse,
  ): Promise<void> {
    response.json(await this.workdays.currentPause(principal));
  }

  @Endpoint({
    method: 'post',
    path: 'workdays/pauses/start',
    input: startPauseSchema,
    output: workdayPauseResponseSchema,
    operationKey: true,
  })
  startPause(
    @CurrentPrincipal() principal: Principal,
    @OperationKey() key: string,
    @Body(new ZodValidationPipe(startPauseSchema)) input: StartPauseDto,
  ) {
    return this.workdays.startPause(principal, key, input);
  }

  @Endpoint({
    method: 'post',
    path: 'workdays/pauses/end',
    input: endPauseSchema,
    output: workdayPauseResponseSchema,
    operationKey: true,
  })
  endPause(
    @CurrentPrincipal() principal: Principal,
    @OperationKey() key: string,
    @Body(new ZodValidationPipe(endPauseSchema)) input: EndPauseDto,
  ) {
    return this.workdays.endPause(principal, key, input);
  }
}
