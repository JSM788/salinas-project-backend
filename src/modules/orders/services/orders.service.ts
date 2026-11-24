import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService, Transaction } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { Principal } from '../../../common/types/principal';
import { reject } from '../../../common/errors/application-error';
import { WebhookAuthService } from './webhook-auth.service';
import {
  BrangoOrderWebhookInput,
  LinkOrderInput,
  OrdersListQuery,
  normalizeInternationalPhone,
  resolveOrderStatus,
} from '../dto/orders.dto';

function webhookPathFor(provider: string): string {
  return `/v1/integrations/${provider}/orders`;
}

const DEFAULT_NOTE_BY_STATUS = {
  pendiente: 'Pedido recibido desde sistema externo.',
  en_transito: 'Pedido en ruta de entrega.',
  entregado: 'Entrega confirmada.',
  observado: 'Entrega observada en ruta.',
} as const;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookAuth: WebhookAuthService,
  ) {}

  private assertManagerAccess(principal: Principal): void {
    if (principal.role !== 'manager') {
      reject('orders_forbidden');
    }
  }

  async ingestExternalOrder(
    companyId: string,
    integrationId: string,
    provider: string,
    input: BrangoOrderWebhookInput,
  ) {
    const normalizedPhone = normalizeInternationalPhone(input.commercialPhone);
    const { originCode, status } = resolveOrderStatus(input);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const actor = input.actor?.trim() || `Webhook ${provider}`;
    const note = input.note?.trim() || DEFAULT_NOTE_BY_STATUS[status];

    return this.prisma.transaction(async (tx) => {
      let matchedMembership = null;
      const rawPhone = input.commercialPhone?.trim() || '';
      const digitsOnly = rawPhone.replace(/\D/g, '');
      const nationalNumber =
        digitsOnly.length >= 9 ? digitsOnly.slice(-9) : digitsOnly;

      if (nationalNumber) {
        const candidates = await tx.membership.findMany({
          where: {
            companyId,
            active: true,
            user: {
              OR: [
                { phone: nationalNumber },
                { phone: rawPhone },
                { phone: digitsOnly },
                { phone: `+${digitsOnly}` },
                { phone: `+51${nationalNumber}` },
                { phone: `51${nationalNumber}` },
                { phone: { endsWith: nationalNumber } },
              ],
            },
          },
          select: {
            id: true,
            role: true,
            user: { select: { displayName: true, email: true, phone: true } },
          },
        });

        if (candidates.length > 0) {
          matchedMembership =
            candidates.find((c) => c.role === 'commercial') ??
            candidates.find((c) => c.role === 'merchandiser') ??
            candidates[0];
        }
      }

      const trimmedRuc = input.customerRuc?.trim() || null;
      const matchedCustomer = trimmedRuc
        ? await tx.customer.findFirst({
            where: { companyId, ruc: trimmedRuc },
            include: {
              branches: {
                where: { active: true },
                orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
                take: 1,
              },
            },
          })
        : null;
      const matchedBranch = matchedCustomer?.branches[0] ?? null;

      const existing = await tx.trackedOrder.findUnique({
        where: {
          companyId_externalOrderId: {
            companyId,
            externalOrderId: input.externalOrderId,
          },
        },
        select: {
          id: true,
          membershipId: true,
          customerId: true,
          branchId: true,
          linkStatus: true,
          evidence: true,
        },
      });

      const resolvedMembershipId =
        existing?.membershipId ?? matchedMembership?.id ?? null;
      const resolvedCustomerId =
        existing?.customerId ?? matchedCustomer?.id ?? null;
      const resolvedBranchId =
        existing?.branchId ?? matchedBranch?.id ?? null;
      const linkStatus = resolvedMembershipId ? 'linked' : 'pending_link';
      const linkReason = resolvedMembershipId
        ? null
        : `No se encontró un comercial activo con el teléfono ${normalizedPhone || input.commercialPhone}`;

      const orderId = existing?.id ?? randomUUID();

      const orderData = {
        membershipId: resolvedMembershipId,
        customerId: resolvedCustomerId,
        branchId: resolvedBranchId,
        status,
        originCode,
        linkStatus,
        linkReason,
        reportedCommercialPhone:
          nationalNumber || digitsOnly || input.commercialPhone,
        reportedCommercialName:
          input.commercialName?.trim() ||
          matchedMembership?.user.displayName ||
          matchedMembership?.user.email ||
          null,
        reportedCustomerName:
          matchedCustomer?.name ?? input.customerName.trim(),
        reportedCustomerRuc: trimmedRuc,
        customerAddress:
          input.customerAddress?.trim() ?? matchedBranch?.address ?? null,
        district: input.district?.trim() ?? matchedBranch?.district ?? null,
        carrierName: input.carrierName?.trim() ?? null,
        carrierPhone: input.carrierPhone?.trim() ?? null,
        packagesCount: input.packagesCount ?? null,
        totalAmount: input.totalAmount?.trim() ?? null,
        deliveryDateLabel: input.deliveryDateLabel?.trim() ?? null,
        notes: note,
        ...(input.evidence
          ? { evidence: input.evidence as Prisma.InputJsonValue }
          : {}),
        lastEventAt: occurredAt,
      };

      const order = existing
        ? await tx.trackedOrder.update({
            where: { id: existing.id },
            data: orderData,
          })
        : await tx.trackedOrder.create({
            data: {
              id: orderId,
              companyId,
              externalOrderId: input.externalOrderId,
              origin: provider,
              ...orderData,
            },
          });

      let shouldInsertEvent = true;
      if (input.externalEventId) {
        const duplicateEvent = await tx.trackedOrderEvent.findUnique({
          where: {
            companyId_orderId_externalEventId: {
              companyId,
              orderId: order.id,
              externalEventId: input.externalEventId,
            },
          },
          select: { id: true },
        });
        if (duplicateEvent) {
          shouldInsertEvent = false;
        }
      }

      if (shouldInsertEvent) {
        await tx.trackedOrderEvent.create({
          data: {
            id: randomUUID(),
            companyId,
            orderId: order.id,
            externalEventId: input.externalEventId ?? null,
            status,
            originCode,
            actor,
            note,
            occurredAt,
          },
        });
      }

      await tx.companyIntegration.update({
        where: { id: integrationId },
        data: { lastSyncAt: new Date() },
      });

      return {
        id: order.id,
        externalOrderId: order.externalOrderId,
        status: status,
        originCode,
        linkStatus: linkStatus as 'linked' | 'pending_link',
        membershipId: order.membershipId,
        customerId: order.customerId,
      };
    });
  }

  async listOrders(principal: Principal, query: OrdersListQuery) {
    this.assertManagerAccess(principal);

    return this.prisma.readTransaction(async (tx) => {
      const baseWhere = this.buildWhere(principal.companyId, query, false);
      const filteredWhere = this.buildWhere(principal.companyId, query, true);

      const [
        total,
        items,
        entregados,
        enTransito,
        pendientes,
        observados,
        pendingLinks,
        integration,
      ] = await Promise.all([
        tx.trackedOrder.count({ where: filteredWhere }),
        tx.trackedOrder.findMany({
          where: filteredWhere,
          orderBy: [{ lastEventAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            membership: {
              select: {
                user: { select: { displayName: true, email: true, phone: true } },
              },
            },
            events: { orderBy: { occurredAt: 'asc' } },
          },
        }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'entregado' } }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'en_transito' } }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'pendiente' } }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'observado' } }),
        tx.trackedOrder.count({
          where: { companyId: principal.companyId, linkStatus: 'pending_link' },
        }),
        tx.companyIntegration.findUnique({
          where: {
            companyId_provider: {
              companyId: principal.companyId,
              provider: 'brango',
            },
          },
          select: { lastSyncAt: true },
        }),
      ]);

      return {
        items: items.map((item) => this.serializeOrder(item)),
        page: query.page,
        pageSize: query.pageSize,
        total,
        kpis: {
          total: entregados + enTransito + pendientes + observados,
          entregados,
          enTransito,
          pendientes,
          observados,
          pendingLinks,
        },
        lastSyncAt: integration?.lastSyncAt?.toISOString() ?? null,
      };
    });
  }

  async getOrderDetail(principal: Principal, orderId: string) {
    this.assertManagerAccess(principal);

    return this.prisma.readTransaction(async (tx) => {
      const order = await tx.trackedOrder.findFirst({
        where: { id: orderId, companyId: principal.companyId },
        include: {
          membership: {
            select: {
              user: { select: { displayName: true, email: true, phone: true } },
            },
          },
          events: { orderBy: { occurredAt: 'asc' } },
        },
      });
      if (!order) reject('order_not_found');
      return this.serializeOrder(order);
    });
  }

  async linkOrder(
    principal: Principal,
    orderId: string,
    input: LinkOrderInput,
  ) {
    this.assertManagerAccess(principal);

    return this.prisma.transaction(async (tx) => {
      const order = await tx.trackedOrder.findFirst({
        where: { id: orderId, companyId: principal.companyId },
      });
      if (!order) reject('order_not_found');

      const member = await tx.membership.findFirst({
        where: {
          id: input.membershipId,
          companyId: principal.companyId,
          active: true,
        },
        select: {
          id: true,
          user: { select: { displayName: true, email: true } },
        },
      });
      if (!member) reject('field_member_not_found');

      let customerName = order.reportedCustomerName;
      let customerAddress = order.customerAddress;
      let district = order.district;
      let resolvedCustomerId = order.customerId;
      let resolvedBranchId = order.branchId;
      if (input.customerId) {
        let branch = await tx.customerBranch.findFirst({
          where: { id: input.customerId, companyId: principal.companyId },
          include: { customer: true },
        });
        if (!branch) {
          branch = await tx.customerBranch.findFirst({
            where: { customerId: input.customerId, companyId: principal.companyId },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            include: { customer: true },
          });
        }
        if (!branch) reject('customer_not_found');
        resolvedCustomerId = branch.customerId;
        resolvedBranchId = branch.id;
        customerName = branch.customer.name;
        customerAddress = branch.address;
        district = branch.district;
      }

      const updated = await tx.trackedOrder.update({
        where: { id: order.id },
        data: {
          membershipId: member.id,
          customerId: resolvedCustomerId,
          branchId: resolvedBranchId,
          reportedCommercialName:
            member.user.displayName || member.user.email,
          reportedCustomerName: customerName,
          customerAddress,
          district,
          linkStatus: 'linked',
          linkReason: null,
        },
        include: {
          membership: {
            select: {
              user: { select: { displayName: true, email: true, phone: true } },
            },
          },
          events: { orderBy: { occurredAt: 'asc' } },
        },
      });

      return this.serializeOrder(updated);
    });
  }

  async listFieldOrders(principal: Principal, query: OrdersListQuery) {
    return this.prisma.readTransaction(async (tx) => {
      const dateRange = query.date
        ? {
            gte: new Date(`${query.date}T00:00:00.000Z`),
            lte: new Date(`${query.date}T23:59:59.999Z`),
          }
        : undefined;

      const baseWhere: Prisma.TrackedOrderWhereInput = {
        companyId: principal.companyId,
        membershipId: principal.membershipId,
        ...(dateRange ? { lastEventAt: dateRange } : {}),
        ...(query.search
          ? {
              OR: [
                {
                  externalOrderId: {
                    contains: query.search,
                    mode: 'insensitive',
                  },
                },
                {
                  reportedCustomerName: {
                    contains: query.search,
                    mode: 'insensitive',
                  },
                },
                {
                  district: {
                    contains: query.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
      };

      const filteredWhere: Prisma.TrackedOrderWhereInput = {
        ...baseWhere,
        ...(query.status ? { status: query.status } : {}),
      };

      const [
        total,
        items,
        entregados,
        enTransito,
        pendientes,
        observados,
      ] = await Promise.all([
        tx.trackedOrder.count({ where: filteredWhere }),
        tx.trackedOrder.findMany({
          where: filteredWhere,
          orderBy: [{ lastEventAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            membership: {
              select: {
                user: { select: { displayName: true, email: true, phone: true } },
              },
            },
            events: { orderBy: { occurredAt: 'asc' } },
          },
        }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'entregado' } }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'en_transito' } }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'pendiente' } }),
        tx.trackedOrder.count({ where: { ...baseWhere, status: 'observado' } }),
      ]);

      return {
        items: items.map((item) => this.serializeOrder(item)),
        page: query.page,
        pageSize: query.pageSize,
        total,
        kpis: {
          total: entregados + enTransito + pendientes + observados,
          entregados,
          enTransito,
          pendientes,
          observados,
          pendingLinks: 0,
        },
        lastSyncAt: null,
      };
    });
  }

  async getIntegrationStatus(principal: Principal, provider: string) {
    this.assertManagerAccess(principal);

    return this.prisma.readTransaction(async (tx) => {
      const integration = await tx.companyIntegration.findUnique({
        where: {
          companyId_provider: {
            companyId: principal.companyId,
            provider,
          },
        },
      });
      return {
        configured: Boolean(integration),
        active: integration?.active ?? false,
        apiKeyPrefix: integration?.apiKeyPrefix ?? null,
        requireSignature: integration?.requireSignature ?? false,
        lastSyncAt: integration?.lastSyncAt?.toISOString() ?? null,
        webhookPath: webhookPathFor(provider),
      };
    });
  }

  async rotateIntegrationKey(
    principal: Principal,
    provider: string,
    input: { requireSignature?: boolean },
  ) {
    this.assertManagerAccess(principal);

    const apiKey = `b2b_${provider.slice(0, 4)}_${randomBytes(24).toString('base64url')}`;
    const apiKeyPrefix = apiKey.slice(0, 16);
    const apiKeyHash = this.webhookAuth.hashApiKey(apiKey);
    const hmacSecret = randomBytes(32).toString('hex');

    const saved = await this.prisma.transaction(async (tx: Transaction) => {
      return tx.companyIntegration.upsert({
        where: {
          companyId_provider: {
            companyId: principal.companyId,
            provider,
          },
        },
        update: {
          apiKeyHash,
          apiKeyPrefix,
          hmacSecret,
          active: true,
          ...(input.requireSignature !== undefined
            ? { requireSignature: input.requireSignature }
            : {}),
        },
        create: {
          id: randomUUID(),
          companyId: principal.companyId,
          provider,
          apiKeyHash,
          apiKeyPrefix,
          hmacSecret,
          requireSignature: input.requireSignature ?? false,
          active: true,
        },
      });
    });

    return {
      apiKey,
      apiKeyPrefix: saved.apiKeyPrefix,
      hmacSecret,
      requireSignature: saved.requireSignature,
      webhookPath: webhookPathFor(provider),
    };
  }

  private buildWhere(
    companyId: string,
    query: OrdersListQuery,
    includeStatus: boolean,
  ): Prisma.TrackedOrderWhereInput {
    const search = query.search?.trim();
    const dateRange = query.date
      ? {
          gte: new Date(`${query.date}T00:00:00.000Z`),
          lte: new Date(`${query.date}T23:59:59.999Z`),
        }
      : undefined;

    return {
      companyId,
      ...(includeStatus && query.status ? { status: query.status } : {}),
      ...(query.linkStatus ? { linkStatus: query.linkStatus } : {}),
      ...(query.membershipId ? { membershipId: query.membershipId } : {}),
      ...(dateRange ? { lastEventAt: dateRange } : {}),
      ...(search
        ? {
            OR: [
              { externalOrderId: { contains: search, mode: 'insensitive' } },
              {
                reportedCustomerName: {
                  contains: search,
                  mode: 'insensitive',
                },
              },
              {
                reportedCommercialName: {
                  contains: search,
                  mode: 'insensitive',
                },
              },
              {
                reportedCommercialPhone: {
                  contains: search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };
  }

  private serializeOrder(item: {
    id: string;
    externalOrderId: string;
    origin: string;
    membershipId: string | null;
    customerId: string | null;
    status: string;
    originCode: string;
    linkStatus: string;
    linkReason: string | null;
    reportedCommercialPhone: string;
    reportedCommercialName: string | null;
    reportedCustomerName: string;
    reportedCustomerRuc: string | null;
    customerAddress: string | null;
    district: string | null;
    carrierName: string | null;
    carrierPhone: string | null;
    packagesCount: number | null;
    totalAmount: string | null;
    deliveryDateLabel: string | null;
    notes: string | null;
    evidence: Prisma.JsonValue | null;
    lastEventAt: Date;
    createdAt: Date;
    membership?: {
      user: { displayName: string | null; email: string; phone: string | null };
    } | null;
    events?: Array<{
      id: string;
      externalEventId: string | null;
      status: string;
      originCode: string;
      actor: string;
      note: string;
      occurredAt: Date;
    }>;
  }) {
    const commercialName =
      item.membership?.user.displayName ??
      item.membership?.user.email ??
      item.reportedCommercialName ??
      null;

    return {
      id: item.id,
      externalOrderId: item.externalOrderId,
      origin: item.origin,
      membershipId: item.membershipId,
      commercialName,
      commercialPhone:
        (
          item.membership?.user.phone ??
          item.reportedCommercialPhone ??
          ''
        ).replace(/\D/g, '') || null,
      customerId: item.customerId,
      customerName: item.reportedCustomerName,
      customerRuc: item.reportedCustomerRuc,
      customerAddress: item.customerAddress,
      district: item.district,
      carrierName: item.carrierName,
      carrierPhone: item.carrierPhone,
      packagesCount: item.packagesCount,
      totalAmount: item.totalAmount,
      deliveryDateLabel: item.deliveryDateLabel,
      status: item.status as 'pendiente' | 'en_transito' | 'entregado' | 'observado',
      originCode: item.originCode as 'PENDING' | 'IN_TRANSIT' | 'DELIVERED' | 'OBSERVED',
      linkStatus: item.linkStatus as 'linked' | 'pending_link',
      linkReason: item.linkReason,
      notes: item.notes,
      evidence:
        item.evidence && typeof item.evidence === 'object'
          ? (item.evidence as Record<string, unknown>)
          : null,
      lastEventAt: item.lastEventAt.toISOString(),
      createdAt: item.createdAt.toISOString(),
      events: item.events?.map((ev) => ({
        id: ev.id,
        externalEventId: ev.externalEventId,
        status: ev.status as 'pendiente' | 'en_transito' | 'entregado' | 'observado',
        originCode: ev.originCode as 'PENDING' | 'IN_TRANSIT' | 'DELIVERED' | 'OBSERVED',
        actor: ev.actor,
        note: ev.note,
        occurredAt: ev.occurredAt.toISOString(),
      })),
    };
  }
}
