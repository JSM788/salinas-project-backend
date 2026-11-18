import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../../database/prisma.service';
import { reject } from '../../../common/errors/application-error';

export interface AuthenticatedWebhookIntegration {
  integrationId: string;
  companyId: string;
  provider: string;
}

const SIGNATURE_TOLERANCE_SECONDS = 300;

@Injectable()
export class WebhookAuthService {
  constructor(private readonly prisma: PrismaService) {}

  hashApiKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  async authenticateRequest(
    provider: string,
    params: {
      authorizationHeader?: string;
      apiKeyHeader?: string;
      signatureHeader?: string;
      timestampHeader?: string;
      rawBody?: Buffer;
    },
  ): Promise<AuthenticatedWebhookIntegration> {
    const rawKey = this.extractApiKey(
      params.authorizationHeader,
      params.apiKeyHeader,
    );
    if (!rawKey) {
      reject('integration_unauthorized');
    }

    const apiKeyHash = this.hashApiKey(rawKey);
    const integration = await this.prisma.readTransaction((tx) =>
      tx.companyIntegration.findFirst({
        where: {
          provider,
          apiKeyHash,
          active: true,
          company: { status: 'active' },
        },
        select: {
          id: true,
          companyId: true,
          provider: true,
          hmacSecret: true,
          requireSignature: true,
        },
      }),
    );

    if (!integration) {
      reject('integration_unauthorized');
    }

    const hasSignatureHeader = Boolean(params.signatureHeader);
    if (
      integration.requireSignature ||
      (hasSignatureHeader && integration.hmacSecret)
    ) {
      this.verifyHmacSignature({
        hmacSecret: integration.hmacSecret,
        signatureHeader: params.signatureHeader,
        timestampHeader: params.timestampHeader,
        rawBody: params.rawBody,
      });
    }

    return {
      integrationId: integration.id,
      companyId: integration.companyId,
      provider: integration.provider,
    };
  }

  private extractApiKey(
    authorization?: string,
    apiKey?: string,
  ): string | null {
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      return apiKey.trim();
    }
    if (
      typeof authorization === 'string' &&
      authorization.startsWith('Bearer ')
    ) {
      const token = authorization.slice(7).trim();
      return token.length > 0 ? token : null;
    }
    return null;
  }

  private verifyHmacSignature(params: {
    hmacSecret: string | null;
    signatureHeader?: string;
    timestampHeader?: string;
    rawBody?: Buffer;
  }): void {
    if (
      !params.hmacSecret ||
      !params.signatureHeader ||
      !params.timestampHeader ||
      !params.rawBody
    ) {
      reject('integration_signature_invalid');
    }

    const tsSeconds = Number(params.timestampHeader);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isFinite(tsSeconds) ||
      Math.abs(nowSeconds - tsSeconds) > SIGNATURE_TOLERANCE_SECONDS
    ) {
      reject('integration_signature_invalid');
    }

    const providedHex = params.signatureHeader.startsWith('sha256=')
      ? params.signatureHeader.slice(7)
      : params.signatureHeader;
    if (!/^[a-f0-9]{64}$/i.test(providedHex)) {
      reject('integration_signature_invalid');
    }

    const signedPayload = `${params.timestampHeader}.${params.rawBody.toString('utf8')}`;
    const expectedHex = createHmac('sha256', params.hmacSecret)
      .update(signedPayload)
      .digest('hex');

    const providedBuf = Buffer.from(providedHex.toLowerCase(), 'hex');
    const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'hex');
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      reject('integration_signature_invalid');
    }
  }
}

