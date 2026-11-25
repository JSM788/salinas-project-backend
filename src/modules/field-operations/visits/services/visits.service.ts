import { Injectable } from '@nestjs/common';
import { storage } from '../../../../common/storage.service';
import { watermarkService } from '../../../../common/watermark.service';
import { PrismaService } from '../../../../database/prisma.service';
import { Principal } from '../../../../common/types/principal';
import { businessDate, databaseDate } from '../../../../common/business-date';
import { reject } from '../../../../common/errors/application-error';
import { FieldCommandsService } from '../../services/field-commands.service';
import { businessDateWindow } from '../../management/services/business-date-window';
import { evaluateCheckInGeofence } from './geofence';
import {
  CheckInDto,
  CloseVisitDto,
  ScheduleVisitDto,
  visitResponse,
} from '../dto/visit.dto';

@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: FieldCommandsService,
  ) {}

  schedule(principal: Principal, key: string, input: ScheduleVisitDto) {
    const isExtraordinary = Boolean(input.observations?.trim());
    if (!isExtraordinary && principal.role !== 'commercial') {
      reject('planning_forbidden');
    }
    if (
      isExtraordinary &&
      principal.role !== 'commercial' &&
      principal.role !== 'merchandiser'
    ) {
      reject('planning_forbidden');
    }
    return this.commands.execute(
      principal,
      key,
      'schedule_visit',
      input,
      async (tx) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        let branch = await tx.customerBranch.findFirst({
          where: { id: input.customerId, companyId: principal.companyId },
          select: { id: true, customerId: true },
        });
        if (!branch) {
          branch = await tx.customerBranch.findFirst({
            where: { customerId: input.customerId, companyId: principal.companyId },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            select: { id: true, customerId: true },
          });
        }
        if (!branch) reject('customer_not_found');

        if (!isExtraordinary) {
          const assigned = await tx.customerAssignment.findUnique({
            where: {
              companyId_branchId_membershipId: {
                ...where,
                branchId: branch.id,
              },
            },
          });
          if (!assigned) reject('customer_not_assigned');
        }
        const scheduledAt = new Date(input.scheduledAt);
        const dateStr = businessDate(scheduledAt, principal.timeZone);
        const date = databaseDate(dateStr);

        if (isExtraordinary) {
          const sameDayVisit = await tx.visit.findFirst({
            where: {
              companyId: principal.companyId,
              branchId: branch.id,
              status: { not: 'cancelled' },
              scheduledAt: businessDateWindow(dateStr, principal.timeZone),
              membership: { role: principal.role },
            },
            select: { id: true },
          });
          if (sameDayVisit) {
            reject('customer_visit_today_conflict');
          }
        }
        const activeWorkday = await tx.workday.findFirst({
          where: { ...where, status: 'active' },
        });

        if (!activeWorkday) {
          const completedDay = await tx.workday.findFirst({
            where: { ...where, businessDate: date, status: 'completed' },
          });
          if (completedDay) reject('workday_already_started');
        }

        if (
          await tx.visit.findFirst({
            where: { ...where, scheduledAt, status: { not: 'cancelled' } },
          })
        ) {
          reject('visit_slot_taken');
        }

        const created = await tx.visit.create({
          data: {
            ...where,
            customerId: branch.customerId,
            branchId: branch.id,
            scheduledAt,
            plannedRole: principal.role,
            workdayId: activeWorkday?.id ?? null,
            observations: input.observations ?? null,
          },
        });

        return visitResponse(created);
      },
    );
  }

  checkIn(principal: Principal, key: string, id: string, input: CheckInDto = {}) {
    return this.commands.execute(
      principal,
      key,
      'check_in',
      [id, input],
      async (tx, context) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        const visit = await tx.visit.findFirst({
          where: { ...where, id },
          include: {
            branch: { select: { latitude: true, longitude: true } },
          },
        });
        if (!visit) reject('visit_not_found');
        const day = await tx.workday.findFirst({
          where: { ...where, status: 'active' },
        });
        if (!day) reject('active_workday_required');

        if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
          const latestAudit = await tx.auditEntry.findFirst({
            where: { companyId: principal.companyId, action: 'company_settings_updated' },
            orderBy: { id: 'desc' },
            select: { details: true },
          });
          let cutoffHour = '23:59';
          const details = latestAudit?.details;
          if (details && typeof details === 'object' && !Array.isArray(details)) {
            const hour = (details as Record<string, unknown>).digitalDisconnectionHour;
            if (typeof hour === 'string' && /^\d{2}:\d{2}$/.test(hour)) {
              cutoffHour = hour;
            }
          }
          const [cutoffHH, cutoffMM] = cutoffHour.split(':').map(Number);
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: principal.timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).formatToParts(new Date());
          const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
          const currentHour = Number(get('hour') === '24' ? '00' : get('hour'));
          const currentMinute = Number(get('minute'));
          if (currentHour > cutoffHH || (currentHour === cutoffHH && currentMinute >= cutoffMM)) {
            reject('digital_disconnection_active');
          }
        }

        if (visit.status !== 'pending') reject('visit_not_pending');
        if (
          businessDate(visit.scheduledAt, principal.timeZone) >
          day.businessDate.toISOString().slice(0, 10)
        )
          reject('visit_scheduled_in_future');
        if (await tx.visit.findFirst({ where: { ...where, status: 'active' } }))
          reject('another_visit_active');
        if (await tx.workdayPause.findFirst({ where: { ...where, status: 'active' } }))
          reject('pause_in_progress');

        const deviceCoords =
          input.latitude !== undefined && input.longitude !== undefined
            ? { latitude: input.latitude, longitude: input.longitude }
            : null;
        const customerCoords =
          visit.branch.latitude !== null && visit.branch.longitude !== null
            ? {
                latitude: visit.branch.latitude,
                longitude: visit.branch.longitude,
              }
            : null;
        const geofence = evaluateCheckInGeofence(deviceCoords, customerCoords);
        if (!geofence.allowed) {
          reject('outside_geofence');
        }

        context.recordDetails({
          geofenceEnabled: !geofence.bypassed,
          geofenceBypassed: geofence.bypassed,
          geofenceRadiusMeters: geofence.radiusMeters,
          distanceMeters: geofence.distanceMeters,
          checkInLatitude: deviceCoords?.latitude ?? null,
          checkInLongitude: deviceCoords?.longitude ?? null,
        });

        return visitResponse(
          await tx.visit.update({
            where: { id: visit.id },
            data: {
              status: 'active',
              workdayId: day.id,
              arrivedAt: new Date(),
              executionRole: day.role ?? principal.role,
              checkInLatitude: deviceCoords?.latitude ?? null,
              checkInLongitude: deviceCoords?.longitude ?? null,
              checkInAccuracy: input.accuracy ?? null,
              version: { increment: 1 },
            },
          }),
        );
      },
    );
  }

  close(principal: Principal, key: string, id: string, input: CloseVisitDto) {
    return this.commands.execute(
      principal,
      key,
      'close_visit',
      [id, input],
      async (tx) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        const visit = await tx.visit.findFirst({
          where: { ...where, id },
          include: { customer: true, branch: true },
        });
        if (!visit) reject('visit_not_found');
        if (
          !(await tx.workday.findFirst({
            where: { ...where, status: 'active' },
          }))
        )
          reject('active_workday_required');
        if (visit.status !== 'active') reject('visit_not_active');
        const auditedVisit =
          visit.executionRole === 'merchandiser' && input.result === 'attended';
        if (input.audit && !auditedVisit) reject('audit_not_allowed');
        if (auditedVisit && !input.audit) reject('audit_required');
        if (auditedVisit && !input.attachment) reject('audit_photo_required');
        const completed = await tx.visit.update({
          where: { id: visit.id },
          data: {
            status: 'completed',
            version: { increment: 1 },
            endedAt: new Date(),
            checkOutLatitude: input.latitude ?? null,
            checkOutLongitude: input.longitude ?? null,
            checkOutAccuracy: input.accuracy ?? null,
            result: input.result,
            observations: input.observations,
            ...(input.audit ? { audit: input.audit } : {}),
          },
        });
        if (input.attachment) {
          // Marca de agua incrustada directamente en los píxeles de la foto
          const coords = visit.checkInLatitude && visit.checkInLongitude
            ? `${visit.checkInLatitude.toFixed(5)}, ${visit.checkInLongitude.toFixed(5)}`
            : visit.branch?.latitude && visit.branch?.longitude
              ? `${visit.branch.latitude.toFixed(5)}, ${visit.branch.longitude.toFixed(5)}`
              : null;

          const watermarkResult = await watermarkService.applyWatermark(
            input.attachment.base64,
            input.attachment.mimeType,
            {
              timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
              coordinates: coords,
              customerName: visit.customer?.name || 'Cliente Salinas',
              district: visit.branch?.district,
              advisor: principal.email,
            },
          );

          // Subida EXCLUSIVA a Cloudflare R2 con el MIME type real del buffer resultante
          const r2Url = await storage.uploadBase64(
            watermarkResult.base64,
            watermarkResult.mimeType,
            'visits',
          );
          if (!r2Url) {
            reject('storage_upload_failed');
          }

          await tx.visitEvidence.create({
            data: {
              ...where,
              visitId: id,
              mimeType: watermarkResult.mimeType,
              content: Buffer.from(r2Url, 'utf-8'),
            },
          });
        }
        return visitResponse(completed);
      },
    );
  }

  async evidence(principal: Principal, id: string) {
    const visit = await this.prisma.visit.findFirst({
      where: {
        companyId: principal.companyId,
        membershipId: principal.membershipId,
        id,
      },
      include: { evidence: true },
    });
    if (!visit) reject('visit_not_found');
    const evidence = visit.evidence[0];
    if (!evidence) return null;
    const content = Buffer.from(evidence.content);
    const str = content.toString('utf-8');
    const isUrl = str.startsWith('http://') || str.startsWith('https://');
    return {
      mimeType: evidence.mimeType,
      base64: isUrl ? str : content.toString('base64'),
    };
  }
}
