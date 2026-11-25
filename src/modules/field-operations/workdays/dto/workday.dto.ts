import { z } from 'zod';
import type { Workday } from '../../../../generated/prisma/client';

const timestamp = z.iso.datetime({ offset: true });
export const startWorkdaySchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    accuracy: z.number().finite().min(0).max(100000).optional(),
  })
  .strict();
export type StartWorkdayDto = z.infer<typeof startWorkdaySchema>;

export const endWorkdaySchema = z
  .object({
    justification: z.string().max(1000).optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    accuracy: z.number().finite().min(0).max(100000).optional(),
  })
  .strict();
export type EndWorkdayDto = z.infer<typeof endWorkdaySchema>;

export const workdayResponseSchema = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  membership_id: z.uuid(),
  business_date: z.iso.date(),
  status: z.enum(['active', 'completed']),
  role: z.enum(['commercial', 'merchandiser']).nullable(),
  started_at: timestamp,
  ended_at: timestamp.nullable(),
  start_latitude: z.number().nullable().optional(),
  start_longitude: z.number().nullable().optional(),
  start_accuracy: z.number().nullable().optional(),
  end_latitude: z.number().nullable().optional(),
  end_longitude: z.number().nullable().optional(),
  end_accuracy: z.number().nullable().optional(),
  completed_visits: z.number().int().nonnegative(),
  total_visits: z.number().int().nonnegative(),
});

export function workdayResponse(day: Workday, statistics: { completed_visits: number; total_visits: number }) {
  return workdayResponseSchema.parse({
    id: day.id,
    company_id: day.companyId,
    membership_id: day.membershipId,
    business_date: day.businessDate.toISOString().slice(0, 10),
    status: day.status,
    role: day.role,
    started_at: day.startedAt.toISOString(),
    ended_at: day.endedAt?.toISOString() ?? null,
    start_latitude: day.startLatitude ?? null,
    start_longitude: day.startLongitude ?? null,
    start_accuracy: day.startAccuracy ?? null,
    end_latitude: day.endLatitude ?? null,
    end_longitude: day.endLongitude ?? null,
    end_accuracy: day.endAccuracy ?? null,
    ...statistics,
  });
}
