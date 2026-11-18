import { Body, Controller, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Endpoint } from '../../../common/decorators/endpoint.decorator';
import { CurrentPrincipal } from '../../../common/decorators/principal.decorator';
import { SessionGuard } from '../../../common/guards/session.guard';
import { ZodValidationPipe } from '../../../common/http/zod-validation.pipe';
import { Principal } from '../../../common/types/principal';
import {
  brangoIntegrationStatusSchema,
  integrationProviderSchema,
  LinkOrderInput,
  linkOrderInputSchema,
  OrdersListQuery,
  ordersListQuerySchema,
  ordersPageResponseSchema,
  rotateBrangoKeyInputSchema,
  rotateBrangoKeyResponseSchema,
  trackedOrderDtoSchema,
} from '../dto/orders.dto';
import { OrdersService } from '../services/orders.service';

@Controller('v1/orders')
@UseGuards(SessionGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Endpoint({
    method: 'get',
    query: ordersListQuerySchema,
    output: ordersPageResponseSchema,
  })
  list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(ordersListQuerySchema)) query: OrdersListQuery,
  ) {
    return this.orders.listOrders(principal, query);
  }

  @Endpoint({
    method: 'get',
    path: 'integrations/:provider',
    output: brangoIntegrationStatusSchema,
  })
  getIntegrationStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('provider', new ZodValidationPipe(integrationProviderSchema))
    provider: string,
  ) {
    return this.orders.getIntegrationStatus(principal, provider);
  }

  @Endpoint({
    method: 'post',
    path: 'integrations/:provider/rotate',
    input: rotateBrangoKeyInputSchema,
    output: rotateBrangoKeyResponseSchema,
  })
  rotateIntegrationKey(
    @CurrentPrincipal() principal: Principal,
    @Param('provider', new ZodValidationPipe(integrationProviderSchema))
    provider: string,
    @Body(new ZodValidationPipe(rotateBrangoKeyInputSchema))
    input: { requireSignature?: boolean },
  ) {
    return this.orders.rotateIntegrationKey(principal, provider, input);
  }

  @Endpoint({
    method: 'get',
    path: ':id',
    output: trackedOrderDtoSchema,
  })
  detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.orders.getOrderDetail(principal, id);
  }

  @Endpoint({
    method: 'post',
    path: ':id/link',
    input: linkOrderInputSchema,
    output: trackedOrderDtoSchema,
  })
  link(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(linkOrderInputSchema)) input: LinkOrderInput,
  ) {
    return this.orders.linkOrder(principal, id, input);
  }
}

