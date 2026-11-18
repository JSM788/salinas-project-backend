import { Controller } from '@nestjs/common';
import { Endpoint } from '../../../common/decorators/endpoint.decorator';
import { platformBrandingResponseSchema } from '../dto/platform.dto';
import { PlatformService } from '../services/platform.service';

@Controller('v1/platform')
export class PublicPlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Endpoint({
    method: 'get',
    path: 'branding',
    output: platformBrandingResponseSchema,
    public: true,
  })
  getBranding() {
    return this.platform.getBranding();
  }
}

