import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  Transaction,
} from '../../../../database/prisma.service';
import { Principal } from '../../../../common/types/principal';
import { reject, rejectField } from '../../../../common/errors/application-error';
import { businessDate, databaseDate, localTimeToUtc } from '../../../../common/business-date';
import { FieldCommandsService } from '../../services/field-commands.service';
import { visitResponse } from '../../visits/dto/visit.dto';
import { workdayResponse } from '../../workdays/dto/workday.dto';
import {
  CreatePauseReasonDto,
  pauseReasonResponse,
  UpdatePauseReasonDto,
  workdayPauseResponse,
} from '../../workdays/dto/pause.dto';
import {
  FieldFilters,
  TeamSchedule,
  fieldMemberSchema,
  SyncWeeklyRoutesDto,
} from '../dto/field-management.dto';
import {
  businessDateWindow,
  businessWeekKey,
  businessWeekWindow,
} from './business-date-window';
import { Prisma } from '../../../../generated/prisma/client';
import { pageResult } from '../../../../common/pagination';
import { RescheduleVisit, CancelVisit } from '../dto/field-management.dto';
import { workdayStatistics } from '../../workdays/services/workday-statistics';

@Injectable()
export class FieldManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: FieldCommandsService,
  ) {}

  private async authorize(tx: Transaction, principal: Principal) {
    const session = await tx.session.findFirst({
      where: {
        tokenHash: principal.tokenHash,
        companyId: principal.companyId,
        membershipId: principal.membershipId,
        expiresAt: { gt: new Date() },
        membership: { active: true },
      },
    });
    if (!session) reject('authentication_required');
    const manager = await tx.membership.findFirst({
      where: {
        id: principal.membershipId,
        companyId: principal.companyId,
        active: true,
        OR: [
          { canManageFieldOperations: true },
          { user: { isPlatformOwner: true } },
        ],
      },
    });
    if (!manager) reject('field_management_forbidden');
  }

  private async read<T>(
    principal: Principal,
    query: (tx: Transaction) => Promise<T>,
  ) {
    return this.prisma.readTransaction(async (tx) => {
      await this.authorize(tx, principal);
      return query(tx);
    });
  }

  private async target(tx: Transaction, principal: Principal, id: string) {
    const member = await tx.membership.findFirst({
      where: {
        id,
        companyId: principal.companyId,
        active: true,
        role: { in: ['commercial', 'merchandiser'] },
      },
    });
    if (!member) rejectField('field_member_not_found', ['membershipId']);
    return member;
  }

  members(principal: Principal, filters: FieldFilters) {
    return this.read(principal, async (tx) => {
      const where: Prisma.MembershipWhereInput = {
        companyId: principal.companyId, active: true,
        role: filters.role ?? { in: ['commercial', 'merchandiser'] },
        ...(filters.search ? { user: { OR: [
          { email: { contains: filters.search, mode: 'insensitive' } },
          { displayName: { contains: filters.search, mode: 'insensitive' } },
        ] } } : {}),
      };
      const total = await tx.membership.count({ where });
      const members = await tx.membership.findMany({
        where,
        include: { user: { select: { email: true, displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return pageResult(members.map((member) =>
        fieldMemberSchema.parse({
          id: member.id,
          email: member.user.email,
          displayName: member.user.displayName,
          role: member.role,
        }),
      ), total, filters);
    });
  }

  customers(principal: Principal, membershipId: string, filters: FieldFilters) {
    return this.read(principal, async (tx) => {
      await this.target(tx, principal, membershipId);
      const where: Prisma.CustomerBranchWhereInput = {
          companyId: principal.companyId,
          active: true,
          assignments: {
            some: { companyId: principal.companyId, membershipId },
          },
          ...(filters.search ? { OR: [
            { name: { contains: filters.search, mode: 'insensitive' } },
            { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
            { customer: { ruc: { contains: filters.search } } },
          ] } : {}),
        };
      const total = await tx.customerBranch.count({ where });
      const branches = await tx.customerBranch.findMany({
        where,
        select: { id: true, name: true, address: true, customer: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return pageResult(
        branches.map((b) => ({
          id: b.id,
          name: b.customer.name,
          branchName: b.name,
          address: b.address,
        })),
        total,
        filters,
      );
    });
  }

  agenda(principal: Principal, filters: FieldFilters) {
    return this.read(principal, async (tx) => {
      const conditions: Prisma.VisitWhereInput[] = [];
      if (filters.role) conditions.push({ OR: [
        { executionRole: filters.role },
        { executionRole: null, plannedRole: filters.role },
      ] });
      if (filters.search) conditions.push({ OR: [
        { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
        { membership: { user: { email: { contains: filters.search, mode: 'insensitive' } } } },
      ] });
      let scheduledAtFilter: Prisma.DateTimeFilter | undefined;
      if (filters.date) {
        scheduledAtFilter = businessDateWindow(filters.date, principal.timeZone);
      } else if (filters.dateFrom || filters.dateTo) {
        const gte = filters.dateFrom
          ? businessDateWindow(filters.dateFrom, principal.timeZone).gte
          : undefined;
        const lt = filters.dateTo
          ? businessDateWindow(filters.dateTo, principal.timeZone).lt
          : undefined;
        scheduledAtFilter = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
      }

      const where: Prisma.VisitWhereInput = {
        companyId: principal.companyId,
        ...(filters.membershipId ? { membershipId: filters.membershipId } : {}),
        ...(scheduledAtFilter ? { scheduledAt: scheduledAtFilter } : {}),
        ...(filters.workdayDate ? { workday: { businessDate: databaseDate(filters.workdayDate) } } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(conditions.length ? { AND: conditions } : {}),
      };
      const total = await tx.visit.count({ where });
      const visits = await tx.visit.findMany({
        where,
        include: {
          customer: true,
          branch: true,
          evidence: { select: { visitId: true } },
          membership: { include: { user: { select: { email: true } } } },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return pageResult(visits.map((visit) => ({
        ...visitResponse(visit),
        branch_id: visit.branchId,
        branch_name: visit.branch.name,
        customer_name: visit.customer.name,
        customer_address: visit.branch.address,
        customer_ruc: visit.customer.ruc,
        customer_district: visit.branch.district,
        customer_latitude: visit.branch.latitude,
        customer_longitude: visit.branch.longitude,
        has_evidence: visit.evidence.length > 0,
        member_email: visit.membership.user.email,
        member_role: visit.executionRole ?? visit.plannedRole,
      })), total, filters);
    });
  }

  workdays(principal: Principal, filters: FieldFilters) {
    return this.read(principal, async (tx) => {
      const where: Prisma.WorkdayWhereInput = {
        companyId: principal.companyId,
        ...(filters.membershipId ? { membershipId: filters.membershipId } : {}),
        ...(filters.role ? { role: filters.role } : {}),
        ...(filters.date
          ? { businessDate: databaseDate(filters.date) }
          : filters.dateFrom || filters.dateTo
          ? {
              businessDate: {
                ...(filters.dateFrom ? { gte: databaseDate(filters.dateFrom) } : {}),
                ...(filters.dateTo ? { lte: databaseDate(filters.dateTo) } : {}),
              },
            }
          : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.search ? { membership: { user: { email: { contains: filters.search, mode: 'insensitive' } } } } : {}),
      };
      const total = await tx.workday.count({ where });
      const days = await tx.workday.findMany({
        where,
        include: {
          membership: { include: { user: { select: { email: true } } } },
        },
        orderBy: [{ businessDate: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      const statistics = await workdayStatistics(tx, days.map((day) => day.id));
      return pageResult(days.map((day) => ({
        ...workdayResponse(day, statistics.get(day.id)!),
        member_email: day.membership.user.email,
        member_role: day.role,
      })), total, filters);
    });
  }

  evidence(principal: Principal, id: string) {
    return this.read(principal, async (tx) => {
      const visit = await tx.visit.findFirst({
        where: { id, companyId: principal.companyId },
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
    });
  }

  schedule(principal: Principal, key: string, input: TeamSchedule) {
    return this.commands.execute(
      principal,
      key,
      'schedule_team_visit',
      input,
      async (tx) => {
        const member = await this.target(tx, principal, input.membershipId);
        const where = {
          companyId: principal.companyId,
          membershipId: input.membershipId,
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
        if (!branch) rejectField('customer_not_found', ['customerId']);
        const assigned = await tx.customerAssignment.findUnique({
          where: {
            companyId_branchId_membershipId: {
              ...where,
              branchId: branch.id,
            },
          },
        });
        if (!assigned) rejectField('customer_not_assigned', ['customerId']);
        const scheduledAt = new Date(input.scheduledAt);
        const date = databaseDate(
          businessDate(scheduledAt, principal.timeZone),
        );
        if (
          await tx.workday.findFirst({
            where: { ...where, OR: [
              { businessDate: date },
              { status: 'active', businessDate: { gte: date } },
            ] },
          })
        )
          rejectField('workday_already_started', ['scheduledAt']);
        if (await tx.visit.findFirst({ where: { ...where, scheduledAt, status: { not: 'cancelled' } } }))
          rejectField('visit_slot_taken', ['scheduledAt']);
        return visitResponse(
          await tx.visit.create({
            data: {
              ...where,
              customerId: branch.customerId,
              branchId: branch.id,
              scheduledAt,
              plannedRole: member.role,
            },
          }),
        );
      },
      {
        requiredPermission: 'manage_field_operations',
        targetMembershipId: input.membershipId,
      },
    );
  }

  private async assertPlanningOpen(tx: Transaction, principal: Principal,
    membershipId: string, scheduledAt: Date, field?: string) {
    const date = databaseDate(businessDate(scheduledAt, principal.timeZone));
    if (await tx.workday.findFirst({ where: {
      companyId: principal.companyId, membershipId,
      OR: [{ businessDate: date }, { status: 'active', businessDate: { gte: date } }],
    } })) {
      if (field) rejectField('workday_already_started', [field]);
      reject('workday_already_started');
    }
  }

  private async visitOwner(principal: Principal, id: string) {
    const visit = await this.read(principal, (tx) => tx.visit.findFirst({
      where: { id, companyId: principal.companyId }, select: { membershipId: true },
    }));
    if (!visit) reject('visit_not_found');
    return visit.membershipId;
  }

  async reschedule(principal: Principal, key: string, id: string, input: RescheduleVisit) {
    const membershipId = await this.visitOwner(principal, id);
    return this.commands.execute(principal, key, 'reschedule_team_visit', [id, input], async (tx, context) => {
      const visit = await tx.visit.findFirst({ where: { id, companyId: principal.companyId, membershipId } });
      if (!visit) reject('visit_not_found');
      if (visit.version !== input.expectedVersion) reject('visit_version_conflict');
      await this.assertPlanningOpen(tx, principal, membershipId, visit.scheduledAt);
      if (visit.status !== 'pending') reject('visit_not_pending');
      const scheduledAt = new Date(input.scheduledAt);
      await this.assertPlanningOpen(tx, principal, membershipId, scheduledAt, 'scheduledAt');
      if (!await tx.customerAssignment.findUnique({ where: {
        companyId_branchId_membershipId: { companyId: principal.companyId, branchId: visit.branchId, membershipId },
      } })) reject('customer_not_assigned');
      if (await tx.visit.findFirst({ where: {
        companyId: principal.companyId, membershipId, scheduledAt,
        id: { not: id }, status: { not: 'cancelled' },
      } })) rejectField('visit_slot_taken', ['scheduledAt']);
      context.recordDetails({ previousScheduledAt: visit.scheduledAt.toISOString(),
        scheduledAt: scheduledAt.toISOString(), previousVersion: visit.version,
        version: visit.version + 1 });
      return visitResponse(await tx.visit.update({ where: { id },
        data: { scheduledAt, version: { increment: 1 } },
      }));
    }, { requiredPermission: 'manage_field_operations', targetMembershipId: membershipId });
  }

  async cancel(principal: Principal, key: string, id: string, input: CancelVisit) {
    const membershipId = await this.visitOwner(principal, id);
    return this.commands.execute(principal, key, 'cancel_team_visit', [id, input], async (tx, context) => {
      const visit = await tx.visit.findFirst({ where: { id, companyId: principal.companyId, membershipId } });
      if (!visit) reject('visit_not_found');
      if (visit.version !== input.expectedVersion) reject('visit_version_conflict');
      await this.assertPlanningOpen(tx, principal, membershipId, visit.scheduledAt);
      if (visit.status !== 'pending') reject('visit_not_pending');
      context.recordDetails({ previousScheduledAt: visit.scheduledAt.toISOString(),
        scheduledAt: visit.scheduledAt.toISOString(), previousStatus: visit.status,
        status: 'cancelled', reason: input.reason ?? null,
        previousVersion: visit.version, version: visit.version + 1 });
      return visitResponse(await tx.visit.update({ where: { id }, data: {
        status: 'cancelled', cancelledAt: new Date(), cancellationReason: input.reason ?? null,
        version: { increment: 1 },
      } }));
    }, { requiredPermission: 'manage_field_operations', targetMembershipId: membershipId });
  }

  async syncWeeklyRoutes(
    principal: Principal,
    key: string,
    input: SyncWeeklyRoutesDto,
  ) {
    // Reject repeating the same customer within the same calendar week payload.
    const payloadByWeek = new Map<string, Set<string>>();
    for (const day of input.days) {
      const weekKey = businessWeekKey(day.date);
      const seen = payloadByWeek.get(weekKey) ?? new Set<string>();
      for (const customerId of day.customerIds) {
        if (seen.has(customerId)) {
          rejectField('customer_already_scheduled_this_week', ['days']);
        }
        seen.add(customerId);
      }
      payloadByWeek.set(weekKey, seen);
    }

    return this.commands.execute(
      principal,
      key,
      'sync_weekly_routes',
      input,
      async (tx, context) => {
        const member = await this.target(tx, principal, input.membershipId);
        const todayDate = businessDate(new Date(), principal.timeZone || 'America/Lima');
        const unlockedDays: Array<{ date: string; customerIds: string[]; nonPendingIds: Set<string> }> = [];

        // Phase 1: clear replaceable pending visits on unlocked days before checking week uniqueness.
        // Past days and days whose workday has already started (active or ended) are frozen and untouchable.
        for (const day of input.days) {
          if (day.date < todayDate) {
            continue;
          }
          const dateObj = databaseDate(day.date);
          const workday = await tx.workday.findFirst({
            where: {
              companyId: principal.companyId,
              membershipId: input.membershipId,
              OR: [
                { businessDate: dateObj },
                { status: 'active', businessDate: { gte: dateObj } },
              ],
            },
          });
          if (workday) {
            continue;
          }

          const window = businessDateWindow(day.date, principal.timeZone);
          await tx.visit.deleteMany({
            where: {
              companyId: principal.companyId,
              membershipId: input.membershipId,
              status: 'pending',
              scheduledAt: { gte: window.gte, lt: window.lt },
            },
          });

          unlockedDays.push({
            date: day.date,
            customerIds: day.customerIds,
            nonPendingIds: new Set<string>(),
          });
        }

        // Phase 2: prevent scheduling customers already visited or scheduled elsewhere in the same week.
        const insertingByWeek = new Map<string, { date: string; customerIds: string[] }>();
        for (const day of unlockedDays) {
          const toInsert = day.customerIds.filter((id) => !day.nonPendingIds.has(id));
          if (toInsert.length === 0) continue;
          const weekKey = businessWeekKey(day.date);
          const entry = insertingByWeek.get(weekKey) ?? { date: day.date, customerIds: [] };
          entry.customerIds.push(...toInsert);
          insertingByWeek.set(weekKey, entry);
        }

        for (const { date, customerIds } of insertingByWeek.values()) {
          const resolvedBranches = await tx.customerBranch.findMany({
            where: {
              companyId: principal.companyId,
              OR: [
                { id: { in: customerIds } },
                { customerId: { in: customerIds }, isDefault: true },
              ],
            },
            select: { id: true },
          });
          const branchIdsToCheck = Array.from(
            new Set([...customerIds, ...resolvedBranches.map((b) => b.id)]),
          );
          const existingInWeek = await tx.visit.findFirst({
            where: {
              companyId: principal.companyId,
              membershipId: input.membershipId,
              branchId: { in: branchIdsToCheck },
              status: { not: 'cancelled' },
              scheduledAt: businessWeekWindow(date, principal.timeZone),
            },
          });
          if (existingInWeek) {
            rejectField('customer_already_scheduled_this_week', ['days']);
          }
        }

        let scheduledCount = 0;

        for (const day of unlockedDays) {
          for (let index = 0; index < day.customerIds.length; index++) {
            const branchOrCustomerId = day.customerIds[index];
            if (day.nonPendingIds.has(branchOrCustomerId)) continue;
            let branch = await tx.customerBranch.findFirst({
              where: { id: branchOrCustomerId, companyId: principal.companyId },
            });
            if (!branch) {
              branch = await tx.customerBranch.findFirst({
                where: { customerId: branchOrCustomerId, companyId: principal.companyId },
                orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
              });
            }
            if (!branch) continue;

            const assignment = await tx.customerAssignment.findUnique({
              where: {
                companyId_branchId_membershipId: {
                  companyId: principal.companyId,
                  branchId: branch.id,
                  membershipId: input.membershipId,
                },
              },
            });
            if (!assignment) {
              await tx.customerAssignment.create({
                data: {
                  companyId: principal.companyId,
                  customerId: branch.customerId,
                  branchId: branch.id,
                  membershipId: input.membershipId,
                },
              });
            }

            const hour = 9 + Math.floor(index * 1.5);
            const minute = (index % 2) * 30;
            const hourStr = String(hour).padStart(2, '0');
            const minStr = String(minute).padStart(2, '0');
            const scheduledAt = localTimeToUtc(
              day.date,
              `${hourStr}:${minStr}`,
              principal.timeZone || 'America/Lima',
            );

            await tx.visit.create({
              data: {
                companyId: principal.companyId,
                membershipId: input.membershipId,
                customerId: branch.customerId,
                branchId: branch.id,
                scheduledAt,
                stopOrder: index + 1,
                plannedRole: member.role,
              },
            });
            scheduledCount++;
          }
        }

        context.recordDetails({
          membershipId: input.membershipId,
          scheduledCount,
          daysCount: input.days.length,
        });

        return { id: principal.membershipId, scheduled: scheduledCount };
      },
      {
        requiredPermission: 'manage_field_operations',
        targetMembershipId: input.membershipId,
      },
    );
  }

  listPauseReasons(principal: Principal) {
    return this.read(principal, async (tx) => {
      const reasons = await tx.pauseReason.findMany({
        where: { companyId: principal.companyId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return reasons.map(pauseReasonResponse);
    });
  }

  createPauseReason(
    principal: Principal,
    key: string,
    input: CreatePauseReasonDto,
  ) {
    return this.commands.execute(
      principal,
      key,
      'create_pause_reason',
      input,
      async (tx, context) => {
        const existing = await tx.pauseReason.findFirst({
          where: {
            companyId: principal.companyId,
            name: { equals: input.name, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (existing) rejectField('pause_reason_exists', ['name']);

        const created = await tx.pauseReason.create({
          data: {
            companyId: principal.companyId,
            name: input.name,
          },
        });
        context.recordDetails({ name: created.name });
        return pauseReasonResponse(created);
      },
      { requiredPermission: 'manage_field_operations' },
    );
  }

  updatePauseReason(
    principal: Principal,
    key: string,
    id: string,
    input: UpdatePauseReasonDto,
  ) {
    return this.commands.execute(
      principal,
      key,
      'update_pause_reason',
      [id, input],
      async (tx, context) => {
        const current = await tx.pauseReason.findFirst({
          where: { companyId: principal.companyId, id },
        });
        if (!current) reject('pause_reason_not_found');

        if (input.name !== undefined) {
          const duplicate = await tx.pauseReason.findFirst({
            where: {
              companyId: principal.companyId,
              id: { not: id },
              name: { equals: input.name, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (duplicate) rejectField('pause_reason_exists', ['name']);
        }

        const updated = await tx.pauseReason.update({
          where: { id: current.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        });
        context.recordDetails({
          ...(input.name !== undefined ? { name: updated.name } : {}),
          ...(input.active !== undefined ? { active: updated.active } : {}),
        });
        return pauseReasonResponse(updated);
      },
      { requiredPermission: 'manage_field_operations' },
    );
  }

  workdayPauses(principal: Principal, filters: FieldFilters) {
    return this.read(principal, async (tx) => {
      const where: Prisma.WorkdayPauseWhereInput = {
        companyId: principal.companyId,
        ...(filters.membershipId ? { membershipId: filters.membershipId } : {}),
        ...(filters.date
          ? { workday: { businessDate: databaseDate(filters.date) } }
          : filters.dateFrom || filters.dateTo
          ? {
              workday: {
                businessDate: {
                  ...(filters.dateFrom ? { gte: databaseDate(filters.dateFrom) } : {}),
                  ...(filters.dateTo ? { lte: databaseDate(filters.dateTo) } : {}),
                },
              },
            }
          : {}),
      };
      const total = await tx.workdayPause.count({ where });
      const rows = await tx.workdayPause.findMany({
        where,
        include: {
          workday: { select: { businessDate: true } },
        },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return pageResult(
        rows.map((row) => workdayPauseResponse(row, row.workday.businessDate)),
        total,
        filters,
      );
    });
  }
}
