import { z } from 'zod';

export const integrationProviderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{2,32}$/);

export const brangoOriginCodeSchema = z.enum([
  'PENDING',
  'IN_TRANSIT',
  'DELIVERED',
  'OBSERVED',
]);

export const orderDeliveryStatusSchema = z.enum([
  'pendiente',
  'en_transito',
  'entregado',
  'observado',
]);

export type BrangoOriginCode = z.infer<typeof brangoOriginCodeSchema>;
export type OrderDeliveryStatus = z.infer<typeof orderDeliveryStatusSchema>;

const ORIGIN_TO_STATUS: Record<BrangoOriginCode, OrderDeliveryStatus> = {
  PENDING: 'pendiente',
  IN_TRANSIT: 'en_transito',
  DELIVERED: 'entregado',
  OBSERVED: 'observado',
};

const STATUS_TO_ORIGIN: Record<OrderDeliveryStatus, BrangoOriginCode> = {
  pendiente: 'PENDING',
  en_transito: 'IN_TRANSIT',
  entregado: 'DELIVERED',
  observado: 'OBSERVED',
};

export function resolveOrderStatus(input: {
  originCode?: BrangoOriginCode;
  status?: OrderDeliveryStatus;
}): { originCode: BrangoOriginCode; status: OrderDeliveryStatus } {
  if (input.originCode) {
    return {
      originCode: input.originCode,
      status: ORIGIN_TO_STATUS[input.originCode],
    };
  }
  const status = input.status ?? 'pendiente';
  return {
    originCode: STATUS_TO_ORIGIN[status],
    status,
  };
}

/**
 * Limpia y normaliza teléfonos a solo dígitos, removiendo cualquier '+' o separador.
 */
export function normalizeInternationalPhone(raw: string): string {
  return raw.trim().replace(/\D/g, '');
}

export const brangoEvidenceSchema = z
  .object({
    imageUrl: z.string().trim().max(2000).optional(),
    receivedBy: z.string().trim().max(200).optional(),
    documentId: z.string().trim().max(60).optional(),
    capturedAt: z.string().trim().max(80).optional(),
    cargoTag: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

export const brangoOrderWebhookSchema = z
  .object({
    externalOrderId: z.string().trim().min(1).max(120),
    externalEventId: z.string().trim().min(1).max(120).optional(),
    originCode: brangoOriginCodeSchema.optional(),
    status: orderDeliveryStatusSchema.optional(),
    commercialPhone: z.string().trim().min(4).max(40),
    commercialName: z.string().trim().max(150).optional(),
    customerName: z.string().trim().min(1).max(200),
    customerRuc: z.string().trim().max(30).optional(),
    customerAddress: z.string().trim().max(300).optional(),
    district: z.string().trim().max(120).optional(),
    carrierName: z.string().trim().max(150).optional(),
    carrierPhone: z.string().trim().max(40).optional(),
    packagesCount: z.coerce.number().int().min(0).max(100000).optional(),
    totalAmount: z.string().trim().max(60).optional(),
    deliveryDateLabel: z.string().trim().max(100).optional(),
    actor: z.string().trim().max(120).optional(),
    note: z.string().trim().max(1000).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    evidence: brangoEvidenceSchema.optional(),
  })
  .strict();

export type BrangoOrderWebhookInput = z.infer<typeof brangoOrderWebhookSchema>;

export const brangoWebhookResponseSchema = z.object({
  id: z.uuid(),
  externalOrderId: z.string(),
  status: orderDeliveryStatusSchema,
  originCode: brangoOriginCodeSchema,
  linkStatus: z.enum(['linked', 'pending_link']),
  membershipId: z.uuid().nullable(),
  customerId: z.uuid().nullable(),
});

export const ordersListQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    status: orderDeliveryStatusSchema.optional(),
    linkStatus: z.enum(['linked', 'pending_link']).optional(),
    membershipId: z.uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type OrdersListQuery = z.infer<typeof ordersListQuerySchema>;

export const orderEventDtoSchema = z.object({
  id: z.uuid(),
  externalEventId: z.string().nullable(),
  status: orderDeliveryStatusSchema,
  originCode: brangoOriginCodeSchema,
  actor: z.string(),
  note: z.string(),
  occurredAt: z.string(),
});

export const trackedOrderDtoSchema = z.object({
  id: z.uuid(),
  externalOrderId: z.string(),
  origin: z.string(),
  membershipId: z.uuid().nullable(),
  commercialName: z.string().nullable(),
  commercialPhone: z.string(),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  customerRuc: z.string().nullable(),
  customerAddress: z.string().nullable(),
  district: z.string().nullable(),
  carrierName: z.string().nullable(),
  carrierPhone: z.string().nullable(),
  packagesCount: z.number().int().nullable(),
  totalAmount: z.string().nullable(),
  deliveryDateLabel: z.string().nullable(),
  status: orderDeliveryStatusSchema,
  originCode: brangoOriginCodeSchema,
  linkStatus: z.enum(['linked', 'pending_link']),
  linkReason: z.string().nullable(),
  notes: z.string().nullable(),
  evidence: brangoEvidenceSchema.nullable(),
  lastEventAt: z.string(),
  createdAt: z.string(),
  events: z.array(orderEventDtoSchema).optional(),
});

export const ordersPageResponseSchema = z.object({
  items: z.array(trackedOrderDtoSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  kpis: z.object({
    total: z.number().int(),
    entregados: z.number().int(),
    enTransito: z.number().int(),
    pendientes: z.number().int(),
    observados: z.number().int(),
    pendingLinks: z.number().int(),
  }),
  lastSyncAt: z.string().nullable(),
});

export const linkOrderInputSchema = z
  .object({
    membershipId: z.uuid(),
    customerId: z.uuid().optional(),
  })
  .strict();

export type LinkOrderInput = z.infer<typeof linkOrderInputSchema>;

export const brangoIntegrationStatusSchema = z.object({
  configured: z.boolean(),
  active: z.boolean(),
  apiKeyPrefix: z.string().nullable(),
  requireSignature: z.boolean(),
  lastSyncAt: z.string().nullable(),
  webhookPath: z.string(),
});

export const rotateBrangoKeyInputSchema = z
  .object({
    requireSignature: z.boolean().optional(),
  })
  .strict();

export const rotateBrangoKeyResponseSchema = z.object({
  apiKey: z.string(),
  apiKeyPrefix: z.string(),
  hmacSecret: z.string(),
  requireSignature: z.boolean(),
  webhookPath: z.string(),
});

