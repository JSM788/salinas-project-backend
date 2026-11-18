import { memberListQuerySchema, memberResponseSchema, memberInputSchema } from '../../platform/dto/platform.dto';
import { z } from 'zod';

export const teamQuerySchema = memberListQuerySchema;
export const teamProfileSchema = memberInputSchema.omit({ role: true }).extend({
  email: z.email().max(254).transform(value => value.toLowerCase()),
}).strict();
export type TeamProfileInput = z.infer<typeof teamProfileSchema>;

export const teamMemberResponseSchema = memberResponseSchema.omit({
  isPlatformOwner: true,
});

export const companySettingsSchema = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Use a supported IANA time zone.'),
  name: z.string().trim().min(1).max(150).optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  taxId: z.string().trim().max(32).nullable().optional(),
  logoBase64: z.string().optional(),
  logoMimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']).optional(),
  logoUrl: z.string().url().nullable().optional(),
  digitalDisconnectionHour: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  autoCloseRemainingVisits: z.boolean().optional(),
  antiMockGpsRequired: z.boolean().optional(),
}).strict();
export type CompanySettingsInput = z.infer<typeof companySettingsSchema>;

export const companySettingsResponseSchema = z.object({
  companyId: z.uuid(),
  name: z.string(),
  timeZone: z.string(),
  legalName: z.string().nullable().optional(),
  taxId: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  digitalDisconnectionHour: z.string().optional(),
  autoCloseRemainingVisits: z.boolean().optional(),
  antiMockGpsRequired: z.boolean().optional(),
});
export type CompanySettingsResponse = z.infer<typeof companySettingsResponseSchema>;

