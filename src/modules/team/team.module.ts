import { InvitationsModule } from '../invitations/invitations.module';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { TeamController } from './controllers/team.controller';
import { TeamService } from './services/team.service';
import { WorkdaysModule } from '../field-operations/workdays/workdays.module';

@Module({
  imports: [IdentityModule, InvitationsModule, WorkdaysModule],
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}
