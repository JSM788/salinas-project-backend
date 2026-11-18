import { Controller, Query, UseGuards } from '@nestjs/common';
import { Endpoint } from '../../../common/decorators/endpoint.decorator';
import { CurrentPrincipal } from '../../../common/decorators/principal.decorator';
import { SessionGuard } from '../../../common/guards/session.guard';
import { ZodValidationPipe } from '../../../common/http/zod-validation.pipe';
import { Principal } from '../../../common/types/principal';
import {
  OrdersListQuery,
  ordersListQuerySchema,
  ordersPageResponseSchema,
} from '../dto/orders.dto';
import { OrdersService } from '../services/orders.service';

@Controller('v1/field-operations/orders')
@UseGuards(SessionGuard)
export class FieldOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Endpoint({
    method: 'get',
    query: ordersListQuerySchema,
    output: ordersPageResponseSchema,
  })
  listMyOrders(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(ordersListQuerySchema)) query: OrdersListQuery,
  ) {
    return this.orders.listFieldOrders(principal, query);
  }
}

