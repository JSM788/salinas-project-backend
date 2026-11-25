import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService, Transaction } from '../../../database/prisma.service';
import { Principal } from '../../../common/types/principal';
import { reject, rejectField } from '../../../common/errors/application-error';
import {
  AssignCustomersDto,
  CreateCustomerDto,
  UpdateCustomerDto,
  CustomerStatusDto,
  ImportCustomersDto,
  managedCustomerResponseSchema,
  CustomerFilters,
  customerFiltersSchema,
} from '../dto/customer.dto';
import { pageResult } from '../../../common/pagination';
import { businessDate } from '../../../common/business-date';

const includeBranchDetails = {
  customer: true,
  assignments: {
    include: { membership: { include: { user: { select: { email: true, displayName: true } } } } },
    orderBy: { membershipId: 'asc' as const },
  },
};

type BranchWithDetails = Prisma.CustomerBranchGetPayload<{
  include: typeof includeBranchDetails;
}>;

async function resolveCustomerCoords(
  lat: number | null | undefined,
  lng: number | null | undefined,
  address: string,
): Promise<{ latitude: number | null; longitude: number | null }> {
  if (lat != null && lng != null) {
    return { latitude: lat, longitude: lng };
  }
  if (!address || !address.trim()) {
    return { latitude: null, longitude: null };
  }

  const match3d = address.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (match3d) {
    return { latitude: parseFloat(match3d[1]), longitude: parseFloat(match3d[2]) };
  }
  const matchAt = address.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (matchAt) {
    return { latitude: parseFloat(matchAt[1]), longitude: parseFloat(matchAt[2]) };
  }
  const matchQ = address.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (matchQ) {
    return { latitude: parseFloat(matchQ[1]), longitude: parseFloat(matchQ[2]) };
  }

  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const res = await fetch(address.trim(), { method: 'HEAD', redirect: 'follow' });
      const finalUrl = res.url;
      const m3d = finalUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      if (m3d) return { latitude: parseFloat(m3d[1]), longitude: parseFloat(m3d[2]) };
      const mAt = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (mAt) return { latitude: parseFloat(mAt[1]), longitude: parseFloat(mAt[2]) };
      const mQ = finalUrl.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (mQ) return { latitude: parseFloat(mQ[1]), longitude: parseFloat(mQ[2]) };
    } catch {
      // Ignored
    }
  }

  return { latitude: null, longitude: null };
}

function branchResponse(branch: BranchWithDetails) {
  return managedCustomerResponseSchema.parse({
    id: branch.id,
    customerId: branch.customerId,
    branchId: branch.id,
    branchName: branch.name,
    isDefault: branch.isDefault,
    active: branch.active,
    name: branch.customer.name,
    address: branch.address,
    ruc: branch.customer.ruc,
    district: branch.district,
    zone: branch.zone,
    latitude: branch.latitude,
    longitude: branch.longitude,
    condition: null,
    lastPurchaseDate: null,
    assignments: branch.assignments.map((assignment) => ({
      membershipId: assignment.membershipId,
      email: assignment.membership.user.email,
      displayName: assignment.membership.user.displayName,
      role: assignment.membership.role,
    })),
  });
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  assigned(principal: Principal, filters: CustomerFilters = customerFiltersSchema.parse({})) {
    return this.prisma.readTransaction(async (tx) => {
      const baseWhere = this.branchWhere(principal, filters);
      const where: Prisma.CustomerBranchWhereInput =
        filters.scope === 'company'
          ? baseWhere
          : {
              AND: [
                baseWhere,
                {
                  assignments: {
                    some: {
                      membershipId: principal.membershipId,
                      companyId: principal.companyId,
                    },
                  },
                },
              ],
            };
      const total = await tx.customerBranch.count({ where });
      const items = await tx.customerBranch.findMany({
        where,
        select: {
          id: true,
          customerId: true,
          name: true,
          address: true,
          latitude: true,
          longitude: true,
          customer: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });

      const branchIds = items.map((c) => c.id);
      const todayKey = businessDate(new Date(), principal.timeZone);
      const lookbackStart = new Date(Date.now() - 48 * 3_600_000);
      const upcomingVisits =
        branchIds.length > 0
          ? await tx.visit.findMany({
              where: {
                companyId: principal.companyId,
                branchId: { in: branchIds },
                status: { in: ['pending', 'active'] },
                scheduledAt: { gte: lookbackStart },
              },
              select: {
                branchId: true,
                status: true,
                scheduledAt: true,
                membership: {
                  select: {
                    user: { select: { displayName: true, email: true } },
                  },
                },
              },
              orderBy: { scheduledAt: 'asc' },
            })
          : [];

      const conflictMap = new Map<
        string,
        { status: string; scheduledAt: string; memberName: string; isToday: boolean }
      >();
      for (const v of upcomingVisits) {
        const visitDate = businessDate(v.scheduledAt, principal.timeZone);
        if (visitDate < todayKey) continue;
        const isToday = visitDate === todayKey;
        const existing = conflictMap.get(v.branchId);
        if (!existing || (!existing.isToday && isToday)) {
          conflictMap.set(v.branchId, {
            status: v.status,
            scheduledAt: v.scheduledAt.toISOString(),
            memberName:
              v.membership.user.displayName?.trim() || v.membership.user.email,
            isToday,
          });
        }
      }

      return pageResult(
        items.map((b) => ({
          id: b.id,
          customerId: b.customerId,
          branchId: b.id,
          branchName: b.name,
          name: b.customer.name,
          address: b.address,
          latitude: b.latitude,
          longitude: b.longitude,
          conflictVisit: conflictMap.get(b.id) ?? null,
        })),
        total,
        filters,
      );
    });
  }

  private authorize(principal: Principal): void {
    if (!principal.permissions?.includes('manage_customers'))
      reject('customer_management_forbidden');
  }

  private async lockManager(
    tx: Transaction,
    principal: Principal,
  ): Promise<void> {
    const member = await tx.membership.updateMany({
      where: {
        id: principal.membershipId,
        companyId: principal.companyId,
        active: true,
        OR: [{ canManageCustomers: true }, { user: { isPlatformOwner: true } }],
      },
      data: { transitionVersion: { increment: 1 } },
    });
    const session = await tx.session.findFirst({
      where: {
        tokenHash: principal.tokenHash,
        companyId: principal.companyId,
        membershipId: principal.membershipId,
        expiresAt: { gt: new Date() },
      },
    });
    if (member.count !== 1 || !session) reject('customer_management_forbidden');
  }

  private branchWhere(principal: Principal, filters: CustomerFilters): Prisma.CustomerBranchWhereInput {
    const assignment = {
      companyId: principal.companyId,
      ...(filters.membershipId ? { membershipId: filters.membershipId } : {}),
      ...(filters.role ? { membership: { role: filters.role } } : {}),
    };
    return {
      companyId: principal.companyId,
      ...(filters.status === 'all'
        ? {}
        : { active: filters.status === 'inactive' ? false : true }),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { address: { contains: filters.search, mode: 'insensitive' } },
              { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
              { customer: { ruc: { contains: filters.search } } },
            ],
          }
        : {}),
      ...(filters.district ? { district: { equals: filters.district, mode: 'insensitive' } } : {}),
      ...(filters.zone ? { zone: { equals: filters.zone, mode: 'insensitive' } } : {}),
      ...(filters.assignment === 'unassigned'
        ? { assignments: { none: assignment } }
        : filters.assignment === 'assigned' || filters.membershipId || filters.role
          ? { assignments: { some: assignment } }
          : {}),
    };
  }

  async list(principal: Principal, filters: CustomerFilters = customerFiltersSchema.parse({})) {
    this.authorize(principal);
    return this.prisma.readTransaction(async (tx) => {
      const where = this.branchWhere(principal, filters);
      const total = await tx.customerBranch.count({ where });
      const branches = await tx.customerBranch.findMany({
        where,
        include: includeBranchDetails,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return pageResult(branches.map(branchResponse), total, filters);
    });
  }

  async lookupByRuc(principal: Principal, ruc: string) {
    this.authorize(principal);
    return this.prisma.readTransaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: {
          companyId_ruc: {
            companyId: principal.companyId,
            ruc,
          },
        },
        include: {
          branches: {
            where: { active: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });
      if (!customer) return null;
      return {
        id: customer.id,
        name: customer.name,
        ruc: customer.ruc,
        branches: customer.branches.map((b) => ({
          id: b.id,
          name: b.name,
          address: b.address,
          district: b.district,
          zone: b.zone,
          isDefault: b.isDefault,
        })),
      };
    });
  }

  async assignees(principal: Principal, filters: CustomerFilters = customerFiltersSchema.parse({})) {
    this.authorize(principal);
    return this.prisma.readTransaction(async (tx) => {
      const where: Prisma.MembershipWhereInput = {
        companyId: principal.companyId,
        active: true,
        role: filters.role ?? { in: ['commercial', 'merchandiser'] },
        ...(filters.search
          ? {
              user: {
                OR: [
                  { email: { contains: filters.search, mode: 'insensitive' } },
                  { displayName: { contains: filters.search, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      };
      const total = await tx.membership.count({ where });
      const members = await tx.membership.findMany({
        where,
        include: { user: { select: { email: true, displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      });
      return pageResult(
        members.map((member) => ({
          id: member.id,
          email: member.user.email,
          displayName: member.user.displayName,
          role: member.role,
        })),
        total,
        filters,
      );
    });
  }

  private async assignee(tx: Transaction, principal: Principal, id: string, field: string) {
    const count = await tx.membership.updateMany({
      where: {
        id,
        companyId: principal.companyId,
        active: true,
        role: { in: ['commercial', 'merchandiser'] },
      },
      data: { transitionVersion: { increment: 1 } },
    });
    if (count.count !== 1) rejectField('customer_assignee_not_found', [field]);
    const member = await tx.membership.findFirst({
      where: { id, companyId: principal.companyId, active: true },
    });
    if (!member) rejectField('customer_assignee_not_found', [field]);
    return member;
  }

  async create(principal: Principal, input: CreateCustomerDto) {
    this.authorize(principal);
    return this.prisma.transaction(async (tx) => {
      await this.lockManager(tx, principal);
      if (
        input.commercialMembershipId &&
        (await this.assignee(tx, principal, input.commercialMembershipId, 'commercialMembershipId'))
          .role !== 'commercial'
      )
        rejectField('customer_assignee_not_found', ['commercialMembershipId']);
      if (
        input.merchandiserMembershipId &&
        (await this.assignee(tx, principal, input.merchandiserMembershipId, 'merchandiserMembershipId'))
          .role !== 'merchandiser'
      )
        rejectField('customer_assignee_not_found', ['merchandiserMembershipId']);

      const coords = await resolveCustomerCoords(
        input.latitude,
        input.longitude,
        input.address,
      );

      // Find or create parent Customer by unique (companyId, ruc)
      let customer = await tx.customer.findUnique({
        where: {
          companyId_ruc: {
            companyId: principal.companyId,
            ruc: input.ruc,
          },
        },
        include: { branches: true },
      });

      let branchName = (input.branchName || '').trim();
      let isDefault = false;

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            companyId: principal.companyId,
            name: input.name,
            ruc: input.ruc,
          },
          include: { branches: true },
        });
        if (!branchName) branchName = 'Principal';
        isDefault = true;
      } else {
        if (!branchName) {
          branchName = `Sede ${customer.branches.length + 1}`;
        }
        const duplicateBranch = customer.branches.some(
          (b) =>
            b.name.trim().toLowerCase() === branchName.toLowerCase() ||
            b.address.trim().toLowerCase() === input.address.trim().toLowerCase(),
        );
        if (duplicateBranch) {
          rejectField('customer_branch_exists', ['branchName']);
        }
      }

      const branch = await tx.customerBranch.create({
        data: {
          companyId: principal.companyId,
          customerId: customer.id,
          name: branchName,
          address: input.address,
          district: input.district,
          zone: input.zone || null,
          latitude: coords.latitude,
          longitude: coords.longitude,
          isDefault,
        },
      });

      if (input.commercialMembershipId) {
        await tx.customerAssignment.create({
          data: {
            companyId: principal.companyId,
            customerId: customer.id,
            branchId: branch.id,
            membershipId: input.commercialMembershipId,
          },
        });
      }
      if (input.merchandiserMembershipId) {
        await tx.customerAssignment.create({
          data: {
            companyId: principal.companyId,
            customerId: customer.id,
            branchId: branch.id,
            membershipId: input.merchandiserMembershipId,
          },
        });
      }

      await this.audit(tx, principal, 'customer_created', branch.id);
      const saved = await tx.customerBranch.findUniqueOrThrow({
        where: { id: branch.id },
        include: includeBranchDetails,
      });
      return branchResponse(saved);
    });
  }

  async update(principal: Principal, branchId: string, input: UpdateCustomerDto) {
    this.authorize(principal);
    return this.prisma.transaction(async (tx) => {
      await this.lockManager(tx, principal);
      const existingBranch = await tx.customerBranch.findFirst({
        where: { id: branchId, companyId: principal.companyId },
      });
      if (!existingBranch) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Customer branch not found.',
        });
      }

      const coords = await resolveCustomerCoords(
        input.latitude,
        input.longitude,
        input.address,
      );

      await tx.customer.update({
        where: { id: existingBranch.customerId },
        data: { name: input.name },
      });

      const updated = await tx.customerBranch.update({
        where: { id: existingBranch.id },
        data: {
          name: input.branchName,
          address: input.address,
          district: input.district,
          zone: input.zone || null,
          latitude: coords.latitude,
          longitude: coords.longitude,
        },
        include: includeBranchDetails,
      });

      await this.audit(tx, principal, 'customer_updated', updated.id);
      return branchResponse(updated);
    });
  }

  async setStatus(principal: Principal, branchId: string, input: CustomerStatusDto) {
    this.authorize(principal);
    return this.prisma.transaction(async (tx) => {
      await this.lockManager(tx, principal);
      const existingBranch = await tx.customerBranch.findFirst({
        where: { id: branchId, companyId: principal.companyId },
      });
      if (!existingBranch) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Customer branch not found.',
        });
      }

      const updated = await tx.customerBranch.update({
        where: { id: existingBranch.id },
        data: { active: input.active },
        include: includeBranchDetails,
      });

      await this.audit(
        tx,
        principal,
        input.active ? 'customer_enabled' : 'customer_disabled',
        updated.id,
      );
      return branchResponse(updated);
    });
  }

  async importCustomers(
    principal: Principal,
    input: ImportCustomersDto,
  ): Promise<{ imported: number; skipped: number }> {
    this.authorize(principal);
    return this.prisma.transaction(async (tx) => {
      await this.lockManager(tx, principal);

      // Deduplicate within file by (ruc + branchName/address)
      const uniqueItems = new Map<string, ImportCustomersDto['items'][number]>();
      let skipped = 0;
      for (const item of input.items) {
        const keyPart = (item.branchName || item.address).trim().toLowerCase();
        const compositeKey = `${item.ruc}::${keyPart}`;
        if (uniqueItems.has(compositeKey)) {
          skipped++;
        } else {
          uniqueItems.set(compositeKey, item);
        }
      }

      const rucs = Array.from(new Set(Array.from(uniqueItems.values()).map((i) => i.ruc)));
      const existingCustomers = await tx.customer.findMany({
        where: {
          companyId: principal.companyId,
          ruc: { in: rucs },
        },
        include: { branches: true },
      });
      const customerByRuc = new Map(existingCustomers.map((c) => [c.ruc!, c]));

      let imported = 0;
      for (const item of uniqueItems.values()) {
        let customer = customerByRuc.get(item.ruc);
        if (!customer) {
          customer = await tx.customer.create({
            data: {
              companyId: principal.companyId,
              name: item.name,
              ruc: item.ruc,
            },
            include: { branches: true },
          });
          customerByRuc.set(item.ruc, customer);
        }

        const branchName = (item.branchName || '').trim() ||
          (customer.branches.length === 0 ? 'Principal' : `Sede ${customer.branches.length + 1}`);

        const isDuplicateBranch = customer.branches.some(
          (b) =>
            b.name.trim().toLowerCase() === branchName.toLowerCase() ||
            b.address.trim().toLowerCase() === item.address.trim().toLowerCase(),
        );
        if (isDuplicateBranch) {
          skipped++;
          continue;
        }

        const coords = await resolveCustomerCoords(
          item.latitude,
          item.longitude,
          item.address,
        );

        const branch = await tx.customerBranch.create({
          data: {
            companyId: principal.companyId,
            customerId: customer.id,
            name: branchName,
            address: item.address,
            district: item.district,
            zone: item.zone || null,
            latitude: coords.latitude,
            longitude: coords.longitude,
            isDefault: customer.branches.length === 0,
          },
        });
        customer.branches.push(branch);
        await this.audit(tx, principal, 'customer_created', branch.id);
        imported++;
      }
      return { imported, skipped };
    });
  }

  async assign(
    principal: Principal,
    input: AssignCustomersDto,
  ): Promise<{ updated: number }> {
    this.authorize(principal);
    return this.prisma.transaction(async (tx) => {
      await this.lockManager(tx, principal);
      const target = await this.assignee(tx, principal, input.membershipId, 'membershipId');
      const branches = await tx.customerBranch.findMany({
        where: {
          companyId: principal.companyId,
          id: { in: input.customerIds },
        },
        select: { id: true, customerId: true },
      });
      if (branches.length !== input.customerIds.length)
        rejectField('customer_not_found', ['customerIds']);

      await tx.customerBranch.updateMany({
        where: {
          companyId: principal.companyId,
          id: { in: input.customerIds },
        },
        data: { assignmentVersion: { increment: 1 } },
      });

      await tx.customerAssignment.deleteMany({
        where: {
          companyId: principal.companyId,
          branchId: { in: input.customerIds },
          membership: { role: target.role },
        },
      });
      await tx.customerAssignment.createMany({
        data: branches.map((b) => ({
          companyId: principal.companyId,
          customerId: b.customerId,
          branchId: b.id,
          membershipId: target.id,
        })),
      });
      for (const branchId of input.customerIds)
        await this.audit(tx, principal, 'customer_assigned', branchId);
      return { updated: branches.length };
    });
  }

  private async audit(
    tx: Transaction,
    principal: Principal,
    action: string,
    subjectId: string,
  ) {
    await tx.auditEntry.create({
      data: {
        companyId: principal.companyId,
        membershipId: principal.membershipId,
        action,
        subjectId,
      },
    });
  }
}
