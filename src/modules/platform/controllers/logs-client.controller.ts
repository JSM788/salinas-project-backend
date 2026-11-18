import { Body, Controller, Req } from '@nestjs/common';
import { Endpoint } from '../../../common/decorators/endpoint.decorator';
import { reject } from '../../../common/errors/application-error';
import { FixedWindowLimiter } from '../../../common/http/fixed-window-limiter';
import { ZodValidationPipe } from '../../../common/http/zod-validation.pipe';
import { HttpRequest } from '../../../common/types/http';
import {
  ClientLogInput,
  clientLogInputSchema,
  clientLogResponseSchema,
} from '../dto/platform.dto';
import { PlatformLogsService } from '../services/platform-logs.service';

@Controller('v1/logs')
export class LogsClientController {
  /** Public endpoint (clients log before login): cap writes per remote address. */
  private readonly limiter = new FixedWindowLimiter(60, 60_000);

  constructor(private readonly logs: PlatformLogsService) {}

  @Endpoint({
    method: 'post',
    path: 'client',
    input: clientLogInputSchema,
    output: clientLogResponseSchema,
  })
  ingestClientLog(
    @Body(new ZodValidationPipe(clientLogInputSchema)) input: ClientLogInput,
    @Req() request: HttpRequest,
  ) {
    if (!this.limiter.allow(request.socket.remoteAddress ?? 'unknown'))
      reject('rate_limited');
    return this.logs.ingestClientLog(input);
  }
}

