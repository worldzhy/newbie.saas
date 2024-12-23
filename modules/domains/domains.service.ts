import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import type {Prisma} from '@prisma/client';
import {Domain} from '@prisma/client';
import {URL} from 'url';
import axios from 'axios';
import {
  DOMAIN_NOT_FOUND,
  DOMAIN_NOT_VERIFIED,
  INVALID_DOMAIN,
  UNAUTHORIZED_RESOURCE,
} from '../../errors/errors.constants';
import {DnsService} from '../../providers/dns/dns.service';
import {Expose} from '../../helpers/interfaces';
import {expose} from '../../helpers/expose';
import {PrismaService} from '@framework/prisma/prisma.service';
import {
  DOMAIN_VERIFICATION_HTML,
  DOMAIN_VERIFICATION_TXT,
} from './domains.constants';
import {DomainVerificationMethods} from './domains.interface';
import {generateRandomString} from '@framework/utilities/random.util';

@Injectable()
export class DomainsService {
  constructor(
    private prisma: PrismaService,
    private dnsService: DnsService,
    private configService: ConfigService
  ) {}

  async createDomain(
    teamId: number,
    data: Omit<Omit<Prisma.DomainCreateInput, 'team'>, 'verificationCode'>
  ): Promise<Domain> {
    try {
      const fullUrl = new URL(data.domain);
      data.domain = fullUrl.hostname;
    } catch (error) {}
    if (
      !/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(
        data.domain
      )
    )
      throw new BadRequestException(INVALID_DOMAIN);
    const verificationCode = await generateRandomString();
    const currentProfilePicture = await this.prisma.team.findUniqueOrThrow({
      where: {id: teamId},
      select: {profilePictureUrl: true},
    });
    const parsedProfilePicture = new URL(
      currentProfilePicture.profilePictureUrl
    );
    if (parsedProfilePicture.hostname === 'ui-avatars.com')
      try {
        const img = await axios.get(
          'https://logo.clearbit.com/${data.domain}',
          {
            responseType: 'arraybuffer',
          }
        );
        if (img.data.byteLength > 1)
          await this.prisma.team.update({
            where: {id: teamId},
            data: {
              profilePictureUrl: `https://logo.clearbit.com/${data.domain}`,
            },
          });
      } catch (error) {}

    return this.prisma.domain.create({
      data: {
        ...data,
        verificationCode,
        team: {connect: {id: teamId}},
      },
    });
  }

  async getDomains(
    teamId: number,
    params: {
      skip?: number;
      take?: number;
      cursor?: Prisma.DomainWhereUniqueInput;
      where?: Prisma.DomainWhereInput;
      orderBy?: Prisma.DomainOrderByWithAggregationInput;
    }
  ): Promise<Expose<Domain>[]> {
    const {skip, take, cursor, where, orderBy} = params;
    try {
      const domains = await this.prisma.domain.findMany({
        skip,
        take,
        cursor,
        where: {...where, team: {id: teamId}},
        orderBy,
      });
      return domains.map(team => expose<Domain>(team));
    } catch (error) {
      return [];
    }
  }

  async getDomain(teamId: number, id: number): Promise<Expose<Domain>> {
    const domain = await this.prisma.domain.findUnique({
      where: {id},
    });
    if (!domain) throw new NotFoundException(DOMAIN_NOT_FOUND);
    if (domain.teamId !== teamId)
      throw new UnauthorizedException(UNAUTHORIZED_RESOURCE);
    return expose<Domain>(domain);
  }

  async verifyDomain(
    teamId: number,
    id: number,
    method?: DomainVerificationMethods
  ): Promise<Expose<Domain>> {
    const domain = await this.prisma.domain.findUnique({
      where: {id},
    });
    if (!domain) throw new NotFoundException(DOMAIN_NOT_FOUND);
    if (domain.teamId !== teamId)
      throw new UnauthorizedException(UNAUTHORIZED_RESOURCE);

    if (method === DOMAIN_VERIFICATION_TXT || !method) {
      const txtRecords = await this.dnsService.lookup(domain.domain, 'TXT');
      if (JSON.stringify(txtRecords).includes(domain.verificationCode)) {
        await this.prisma.domain.update({
          where: {id},
          data: {isVerified: true},
        });
      } else if (method) throw new BadRequestException(DOMAIN_NOT_VERIFIED);
    }

    if (method === DOMAIN_VERIFICATION_HTML || !method) {
      let verified = false;
      try {
        const {data} = await axios.get(
          `http://${domain.domain}/.well-known/${this.configService.get<string>(
            'microservices.saas.meta.domainVerificationFile' ??
              'saas-verify.txt'
          )}`
        );
        verified = data.includes(domain.verificationCode);
      } catch (error) {}
      if (verified) {
        await this.prisma.domain.update({
          where: {id},
          data: {isVerified: true},
        });
      } else if (method) throw new BadRequestException(DOMAIN_NOT_VERIFIED);
    }
    return domain;
  }

  async deleteDomain(teamId: number, id: number): Promise<Expose<Domain>> {
    const testDomain = await this.prisma.domain.findUnique({
      where: {id},
    });
    if (!testDomain) throw new NotFoundException(DOMAIN_NOT_FOUND);
    if (testDomain.teamId !== teamId)
      throw new UnauthorizedException(UNAUTHORIZED_RESOURCE);
    const domain = await this.prisma.domain.delete({
      where: {id},
    });
    return expose<Domain>(domain);
  }
}
