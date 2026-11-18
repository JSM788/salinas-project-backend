import { Body, Controller, Headers, Param, Req } from '@nestjs/common';
import { Endpoint } from '../../../common/decorators/endpoint.decorator';
import { ZodValidationPipe } from '../../../common/http/zod-validation.pipe';
import {
  BrangoOrderWebhookInput,
  brangoOrderWebhookSchema,
  brangoWebhookResponseSchema,
  integrationProviderSchema,
} from '../dto/orders.dto';
import { WebhookAuthService } from '../services/webhook-auth.service';
import { OrdersService } from '../services/orders.service';

@Controller('v1/integrations/:provider')
export class BrangoWebhookController {
  constructor(
    private readonly webhookAuth: WebhookAuthService,
    private readonly orders: OrdersService,
  ) {}

  @Endpoint({
    method: 'post',
    path: 'orders',
    public: true,
    input: brangoOrderWebhookSchema,
    output: brangoWebhookResponseSchema,
  })
  async ingestOrder(
    @Param('provider', new ZodValidationPipe(integrationProviderSchema))
    provider: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-api-key') apiKey: string | undefined,
    @Headers('x-webhook-signature') genericSignature: string | undefined,
    @Headers('x-webhook-timestamp') genericTimestamp: string | undefined,
    @Headers('x-brango-signature') brangoSignature: string | undefined,
    @Headers('x-brango-timestamp') brangoTimestamp: string | undefined,
    @Req() request: { rawBody?: Buffer },
    @Body(new ZodValidationPipe(brangoOrderWebhookSchema))
    input: BrangoOrderWebhookInput,
  ) {
    const auth = await this.webhookAuth.authenticateRequest(provider, {
      authorizationHeader: authorization,
      apiKeyHeader: apiKey,
      signatureHeader: genericSignature ?? brangoSignature,
      timestampHeader: genericTimestamp ?? brangoTimestamp,
      rawBody: request.rawBody,
    });

    return this.orders.ingestExternalOrder(
      auth.companyId,
      auth.integrationId,
      provider,
      input,
    );
  }
}
