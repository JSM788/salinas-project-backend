import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService, Transaction } from '../../../../database/prisma.service';
import { Principal } from '../../../../common/types/principal';
import { businessDate, databaseDate, localTimeToUtc } from '../../../../common/business-date';
import { reject } from '../../../../common/errors/application-error';
import { FieldCommandsService } from '../../services/field-commands.service';
import { EndWorkdayDto, StartWorkdayDto, workdayResponse } from '../dto/workday.dto';
import {
  EndPauseDto,
  pauseReasonResponse,
  StartPauseDto,
  workdayPauseResponse,
} from '../dto/pause.dto';
import { businessDateWindow } from '../../management/services/business-date-window';
import { pageResult, PaginationQuery, paginationQuerySchema } from '../../../../common/pagination';
import { workdayStatistics } from './workday-statistics';

const DEFAULT_CUTOFF_HOUR = '23:59';
const MAX_TIMEOUT_MS = 2_147_483_647;

@Injectable()
export class WorkdaysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkdaysService.name);
  private autoCloseTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: FieldCommandsService,
  ) {}

  onModuleInit() {
    void this.runAndScheduleNextAutoClose();
  }

  onModuleDestroy() {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = undefined;
    }
  }

  private async runAndScheduleNextAutoClose() {
    try {
      await this.closeExpiredWorkdays();
    } catch (err) {
      this.logger.warn(
        `Auto-close workdays failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.scheduleNextAutoClose().catch((err) => {
      this.logger.warn(
        `Schedule auto-close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private nextCutoffDelayMs(timeZone: string, cutoffHour: string, now = new Date()): number {
    const todayStr = businessDate(now, timeZone);
    let target = localTimeToUtc(todayStr, cutoffHour, timeZone);
    if (target.getTime() <= now.getTime()) {
      const tomorrowStr = new Date(databaseDate(todayStr).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      target = localTimeToUtc(tomorrowStr, cutoffHour, timeZone);
    }
    return Math.max(1_000, target.getTime() - now.getTime());
  }

  async scheduleNextAutoClose() {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = undefined;
    }

    const now = new Date();
    const companies = await this.prisma.readTransaction((tx) =>
      tx.company.findMany({
        where: { status: 'active' },
        select: { id: true, timeZone: true },
      }),
    );
    if (!companies.length) return;

    let minDelayMs = MAX_TIMEOUT_MS;
    for (const company of companies) {
      const cutoff = await this.prisma.readTransaction((tx) =>
        this.getCompanyCutoffHour(tx, company.id),
      );
      const delayMs = this.nextCutoffDelayMs(company.timeZone, cutoff, now);
      if (delayMs < minDelayMs) minDelayMs = delayMs;
    }

    this.autoCloseTimer = setTimeout(() => {
      void this.runAndScheduleNextAutoClose();
    }, Math.min(minDelayMs, MAX_TIMEOUT_MS));
    this.autoCloseTimer.unref();
  }

  async policy(principal: Principal) {
    const cutoff = await this.prisma.readTransaction((tx) =>
      this.getCompanyCutoffHour(tx, principal.companyId),
    );
    return { cutoff_hour: cutoff, time_zone: principal.timeZone };
  }

  private async getCompanyCutoffHour(tx: Transaction, companyId: string): Promise<string> {
    const latestAudit = await tx.auditEntry.findFirst({
      where: { companyId, action: 'company_settings_updated' },
      orderBy: { id: 'desc' },
      select: { details: true },
    });
    const details = latestAudit?.details;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const hour = (details as Record<string, unknown>).digitalDisconnectionHour;
      if (typeof hour === 'string' && /^\d{2}:\d{2}$/.test(hour)) return hour;
    }
    return DEFAULT_CUTOFF_HOUR;
  }

  private shouldAutoClose(businessDateValue: Date, timeZone: string, cutoffHour: string, now = new Date()): boolean {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const currentDate = `${get('year')}-${get('month')}-${get('day')}`;
    const currentHHMM = `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
    const dayBusinessDate = businessDateValue.toISOString().slice(0, 10);
    return currentDate > dayBusinessDate || (currentDate === dayBusinessDate && currentHHMM >= cutoffHour);
  }

  private async closeWorkdayWithVisits(
    tx: Transaction,
    day: { id: string; companyId: string; membershipId: string },
    now: Date,
    reason: string,
  ) {
    const latestAudit = await tx.auditEntry.findFirst({
      where: { companyId: day.companyId, action: 'company_settings_updated' },
      orderBy: { id: 'desc' },
      select: { details: true },
    });
    let autoClose = true;
    const details = latestAudit?.details;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const flag = (details as Record<string, unknown>).autoCloseRemainingVisits;
      if (typeof flag === 'boolean') autoClose = flag;
    }

    if (autoClose) {
      await tx.visit.updateMany({
        where: {
          companyId: day.companyId,
          membershipId: day.membershipId,
          workdayId: day.id,
          status: { in: ['pending', 'active'] },
        },
        data: {
          status: 'cancelled',
          workdayId: null,
          arrivedAt: null,
          endedAt: null,
          result: null,
          cancelledAt: now,
          cancellationReason: reason,
        },
      });
    } else {
      await tx.visit.updateMany({
        where: {
          companyId: day.companyId,
          membershipId: day.membershipId,
          workdayId: day.id,
          status: { in: ['pending', 'active'] },
        },
        data: {
          workdayId: null,
          arrivedAt: null,
        },
      });
    }
    await tx.workdayPause.updateMany({
      where: {
        companyId: day.companyId,
        membershipId: day.membershipId,
        workdayId: day.id,
        status: 'active',
      },
      data: {
        status: 'completed',
        endedAt: now,
      },
    });
    return tx.workday.update({
      where: { id: day.id },
      data: { status: 'completed', endedAt: now },
    });
  }

  async closeExpiredWorkdays() {
    const now = new Date();
    const { activeDays, companies } = await this.prisma.readTransaction(async (tx) => {
      const activeDays = await tx.workday.findMany({
        where: { status: 'active' },
        select: {
          id: true,
          companyId: true,
          membershipId: true,
          businessDate: true,
        },
      });
      const companyIds = [...new Set(activeDays.map((d) => d.companyId))];
      const companies = companyIds.length
        ? await tx.company.findMany({
            where: { id: { in: companyIds } },
            select: { id: true, timeZone: true },
          })
        : [];
      return { activeDays, companies };
    });
    if (!activeDays.length) return 0;

    const tzByCompany = new Map(companies.map((c) => [c.id, c.timeZone]));
    let closedCount = 0;
    const cutoffCache = new Map<string, string>();
    for (const day of activeDays) {
      const timeZone = tzByCompany.get(day.companyId) ?? 'America/Lima';
      await this.prisma.transaction(async (tx) => {
        let cutoff = cutoffCache.get(day.companyId);
        if (!cutoff) {
          cutoff = await this.getCompanyCutoffHour(tx, day.companyId);
          cutoffCache.set(day.companyId, cutoff);
        }
        if (!this.shouldAutoClose(day.businessDate, timeZone, cutoff, now)) return;
        const fresh = await tx.workday.findUnique({ where: { id: day.id }, select: { status: true } });
        if (fresh?.status !== 'active') return;
        await this.closeWorkdayWithVisits(
          tx,
          day,
          now,
          `Autocierre por Desconexión Digital (Límite ${cutoff} hrs)`,
        );
        closedCount++;
      });
    }
    return closedCount;
  }

  async current(principal: Principal) {
    return this.prisma.transaction(async (tx) => {
      let day = await tx.workday.findFirst({
        where: {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      });
      if (!day) return null;

      if (day.status === 'active') {
        const now = new Date();
        const cutoff = await this.getCompanyCutoffHour(tx, principal.companyId);
        if (this.shouldAutoClose(day.businessDate, principal.timeZone, cutoff, now)) {
          day = await this.closeWorkdayWithVisits(
            tx,
            day,
            now,
            `Autocierre por Desconexión Digital (Límite ${cutoff} hrs)`,
          );
        }
      }

      const statistics = await workdayStatistics(tx, [day.id]);
      return workdayResponse(day, statistics.get(day.id)!);
    });
  }

  async list(principal: Principal, filters: PaginationQuery = paginationQuerySchema.parse({})) {
    return this.prisma.readTransaction(async (tx) => {
      const where = {
        companyId: principal.companyId,
        membershipId: principal.membershipId,
      };
    const total = await tx.workday.count({ where });
    const days = await tx.workday.findMany({
      where,
      orderBy: [{ businessDate: 'desc' }, { id: 'desc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    });
    const statistics = await workdayStatistics(tx, days.map((day) => day.id));
    return pageResult(days.map((day) => workdayResponse(day, statistics.get(day.id)!)), total, filters);
    });
  }

  start(principal: Principal, key: string, input: StartWorkdayDto = {}) {
    const payload = input && Object.keys(input).length > 0 ? input : null;
    return this.commands.execute(
      principal,
      key,
      'start_workday',
      payload,
      async (tx) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        if (
          await tx.workday.findFirst({ where: { ...where, status: 'active' } })
        )
          reject('workday_already_started');
        const date = databaseDate(businessDate(new Date(), principal.timeZone));
        const day = await tx.workday.create({
          data: {
            ...where,
            businessDate: date,
            role: principal.role,
            startLatitude: input.latitude ?? null,
            startLongitude: input.longitude ?? null,
          },
        });
        // Freeze today's planned visits into this workday before any visit is checked in.
        const window = businessDateWindow(date.toISOString().slice(0, 10), principal.timeZone);
        await tx.visit.updateMany({ where: {
          ...where, status: 'pending', scheduledAt: { gte: window.gte, lt: window.lt },
        }, data: { workdayId: day.id } });
        const statistics = await workdayStatistics(tx, [day.id]);
        return workdayResponse(day, statistics.get(day.id)!);
      },
    ).then((res) => {
      void this.scheduleNextAutoClose();
      return res;
    });
  }

  end(principal: Principal, key: string, input: EndWorkdayDto = {}) {
    return this.commands.execute(
      principal,
      key,
      'end_workday',
      input,
      async (tx) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        const day = await tx.workday.findFirst({
          where: { ...where, status: 'active' },
        });
        if (!day) reject('active_workday_required');
        const date = day.businessDate.toISOString().slice(0, 10);
        const window = businessDateWindow(date, principal.timeZone);
        const pending = await tx.visit.findMany({
          where: { ...where, status: { in: ['pending', 'active'] }, scheduledAt: { gte: window.gte, lt: window.lt } },
          select: { id: true },
        });
        if (pending.length > 0) {
          if (!input.justification) {
            reject('visits_remaining');
          }
          await tx.visit.updateMany({
            where: { id: { in: pending.map((p) => p.id) } },
            data: {
              status: 'cancelled',
              workdayId: null,
              arrivedAt: null,
              endedAt: null,
              result: null,
              cancelledAt: new Date(),
              cancellationReason: input.justification,
            },
          });
        }
        const now = new Date();
        await tx.workdayPause.updateMany({
          where: {
            ...where,
            workdayId: day.id,
            status: 'active',
          },
          data: {
            status: 'completed',
            endedAt: now,
            endLatitude: input.latitude ?? null,
            endLongitude: input.longitude ?? null,
          },
        });
        const updated = await tx.workday.update({
          where: { id: day.id },
          data: {
            status: 'completed',
            endedAt: now,
            endLatitude: input.latitude ?? null,
            endLongitude: input.longitude ?? null,
          },
        });
        const statistics = await workdayStatistics(tx, [day.id]);
        return workdayResponse(updated, statistics.get(day.id)!);
      },
    );
  }

  async listPauseReasons(principal: Principal) {
    return this.prisma.readTransaction(async (tx) => {
      const reasons = await tx.pauseReason.findMany({
        where: { companyId: principal.companyId, active: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return reasons.map(pauseReasonResponse);
    });
  }

  async currentPause(principal: Principal) {
    return this.prisma.readTransaction(async (tx) => {
      const day = await tx.workday.findFirst({
        where: {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
          status: 'active',
        },
        select: { id: true, businessDate: true },
      });
      if (!day) return null;
      const pause = await tx.workdayPause.findFirst({
        where: {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
          workdayId: day.id,
          status: 'active',
        },
      });
      return pause ? workdayPauseResponse(pause, day.businessDate) : null;
    });
  }

  startPause(principal: Principal, key: string, input: StartPauseDto) {
    return this.commands.execute(
      principal,
      key,
      'start_pause',
      input,
      async (tx) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        const day = await tx.workday.findFirst({
          where: { ...where, status: 'active' },
        });
        if (!day) reject('active_workday_required');

        const activeVisit = await tx.visit.findFirst({
          where: { ...where, status: 'active' },
          select: { id: true },
        });
        if (activeVisit) reject('visit_active_pause_blocked');

        const activePause = await tx.workdayPause.findFirst({
          where: { ...where, status: 'active' },
          select: { id: true },
        });
        if (activePause) reject('pause_already_active');

        const reason = await tx.pauseReason.findFirst({
          where: {
            companyId: principal.companyId,
            id: input.reason_id,
            active: true,
          },
        });
        if (!reason) reject('pause_reason_not_found');

        const pause = await tx.workdayPause.create({
          data: {
            companyId: principal.companyId,
            membershipId: principal.membershipId,
            workdayId: day.id,
            reasonId: reason.id,
            reasonName: reason.name,
            notes: input.notes?.trim() || null,
            startLatitude: input.latitude ?? null,
            startLongitude: input.longitude ?? null,
          },
        });
        return workdayPauseResponse(pause, day.businessDate);
      },
    );
  }

  endPause(principal: Principal, key: string, input: EndPauseDto = {}) {
    return this.commands.execute(
      principal,
      key,
      'end_pause',
      input,
      async (tx) => {
        const where = {
          companyId: principal.companyId,
          membershipId: principal.membershipId,
        };
        const day = await tx.workday.findFirst({
          where: { ...where, status: 'active' },
        });
        if (!day) reject('active_workday_required');

        const activePause = await tx.workdayPause.findFirst({
          where: { ...where, workdayId: day.id, status: 'active' },
        });
        if (!activePause) reject('active_pause_required');

        const updated = await tx.workdayPause.update({
          where: { id: activePause.id },
          data: {
            status: 'completed',
            endedAt: new Date(),
            endLatitude: input.latitude ?? null,
            endLongitude: input.longitude ?? null,
          },
        });
        return workdayPauseResponse(updated, day.businessDate);
      },
    );
  }
}
