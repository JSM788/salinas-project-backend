import { z } from 'zod';
import type { PauseReason, WorkdayPause } from '../../../../generated/prisma/client';

const timestamp = z.iso.datetime({ offset: true });

export const pauseReasonResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
  created_at: timestamp,
});
export type PauseReasonResponse = z.infer<typeof pauseReasonResponseSchema>;

export const createPauseReasonSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
  })
  .strict();
export type CreatePauseReasonDto = z.infer<typeof createPauseReasonSchema>;

export const updatePauseReasonSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.active !== undefined, {
    message: 'At least one field (name or active) must be provided.',
  });
export type UpdatePauseReasonDto = z.infer<typeof updatePauseReasonSchema>;

export const startPauseSchema = z
  .object({
    reason_id: z.uuid(),
    notes: z.string().trim().max(500).optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    accuracy: z.number().finite().min(0).max(100000).optional(),
  })
  .strict();
export type StartPauseDto = z.infer<typeof startPauseSchema>;

export const endPauseSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    accuracy: z.number().finite().min(0).max(100000).optional(),
  })
  .strict();
export type EndPauseDto = z.infer<typeof endPauseSchema>;

export const workdayPauseResponseSchema = z.object({
  id: z.uuid(),
  workday_id: z.uuid(),
  membership_id: z.uuid(),
  business_date: z.iso.date(),
  reason_id: z.uuid().nullable(),
  reason_name: z.string(),
  notes: z.string().nullable().optional(),
  status: z.enum(['active', 'completed']),
  started_at: timestamp,
  ended_at: timestamp.nullable(),
  start_latitude: z.number().nullable().optional(),
  start_longitude: z.number().nullable().optional(),
  start_accuracy: z.number().nullable().optional(),
  end_latitude: z.number().nullable().optional(),
  end_longitude: z.number().nullable().optional(),
  end_accuracy: z.number().nullable().optional(),
  duration_minutes: z.number().int().nonnegative().nullable(),
});
export type WorkdayPauseResponse = z.infer<typeof workdayPauseResponseSchema>;

export function pauseReasonResponse(row: PauseReason): PauseReasonResponse {
  return pauseReasonResponseSchema.parse({
    id: row.id,
    name: row.name,
    active: row.active,
    created_at: row.createdAt.toISOString(),
  });
}

export function workdayPauseResponse(
  row: WorkdayPause,
  businessDate: Date,
): WorkdayPauseResponse {
  const durationMinutes = row.endedAt
    ? Math.max(
        1,
        Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 60000),
      )
    : null;
  return workdayPauseResponseSchema.parse({
    id: row.id,
    workday_id: row.workdayId,
    membership_id: row.membershipId,
    business_date: businessDate.toISOString().slice(0, 10),
    reason_id: row.reasonId ?? null,
    reason_name: row.reasonName,
    notes: row.notes ?? null,
    status: row.status,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    start_latitude: row.startLatitude ?? null,
    start_longitude: row.startLongitude ?? null,
    start_accuracy: row.startAccuracy ?? null,
    end_latitude: row.endLatitude ?? null,
    end_longitude: row.endLongitude ?? null,
    end_accuracy: row.endAccuracy ?? null,
    duration_minutes: durationMinutes,
  });
}
