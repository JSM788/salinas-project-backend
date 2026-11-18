import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { WebhookAuthService } from './services/webhook-auth.service';
import { OrdersService } from './services/orders.service';
import { BrangoWebhookController } from './controllers/brango-webhook.controller';
import { OrdersController } from './controllers/orders.controller';
import { FieldOrdersController } from './controllers/field-orders.controller';

@Module({
  imports: [IdentityModule],
  controllers: [
    BrangoWebhookController,
    OrdersController,
    FieldOrdersController,
  ],
  providers: [WebhookAuthService, OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}

