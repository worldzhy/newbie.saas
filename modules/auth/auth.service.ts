import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import type {Prisma} from '@prisma/client';
import {Email, MfaMethod, User} from '@prisma/client';
import {compare, hash} from 'bcrypt';
import {createHash} from 'crypto';
import anonymize from 'ip-anonymize';
import {authenticator} from 'otplib';
import {createRandomBytes, createDigest} from '@otplib/plugin-crypto';
import {keyEncoder, keyDecoder} from '@otplib/plugin-thirty-two';
import qrcode from 'qrcode';
import * as randomColor from 'randomcolor';
import {UAParser} from 'ua-parser-js';
import {
  COMPROMISED_PASSWORD,
  EMAIL_USER_CONFLICT,
  EMAIL_VERIFIED_CONFLICT,
  INVALID_CREDENTIALS,
  INVALID_MFA_CODE,
  MFA_BACKUP_CODE_USED,
  MFA_ENABLED_CONFLICT,
  MFA_NOT_ENABLED,
  MFA_PHONE_NOT_FOUND,
  NO_EMAILS,
  NO_TOKEN_PROVIDED,
  SESSION_NOT_FOUND,
  UNVERIFIED_EMAIL,
  UNVERIFIED_LOCATION,
  USER_NOT_FOUND,
} from '../../errors/errors.constants';
import {safeEmail} from '../../helpers/safe-email';
import {GeolocationService} from '../../providers/geolocation/geolocation.service';
import {Expose} from '../../helpers/interfaces';
import {expose} from '../../helpers/expose';
import {PrismaService} from '@framework/prisma/prisma.service';
import {PwnedService} from '../../providers/pwned/pwned.service';
import {
  APPROVE_SUBNET_TOKEN,
  EMAIL_MFA_TOKEN,
  EMAIL_VERIFY_TOKEN,
  LOGIN_ACCESS_TOKEN,
  MERGE_ACCOUNTS_TOKEN,
  MULTI_FACTOR_TOKEN,
  PASSWORD_RESET_TOKEN,
} from '../../providers/tokens/tokens.constants';
import {TokensService} from '../../providers/tokens/tokens.service';
import {TwilioService} from '../../providers/twilio/twilio.service';
import {ApprovedSubnetsService} from '../approved-subnets/approved-subnets.service';
import {RegisterDto} from './auth.dto';
import {
  AccessTokenClaims,
  MfaTokenPayload,
  TokenResponse,
  TotpTokenResponse,
} from './auth.interface';
import {
  teamAdminScopes,
  teamMemberScopes,
  teamMemberScopesCustomized,
  teamOwnerScopes,
  userScopes,
  userScopesCustomized,
} from '../../helpers/scopes';
import axios from 'axios';
import {generateRandomString} from '@framework/utilities/random.util';
import {EmailService} from '@microservices/notification/email/email.service';

@Injectable()
export class AuthService {
  authenticator: typeof authenticator;

  constructor(
    private prisma: PrismaService,
    private email: EmailService,
    private configService: ConfigService,
    private pwnedService: PwnedService,
    private tokensService: TokensService,
    private geolocationService: GeolocationService,
    private approvedSubnetsService: ApprovedSubnetsService,
    private twilioService: TwilioService
  ) {
    this.authenticator = authenticator.create({
      window: [
        this.configService.get<number>(
          'microservices.saas.security.totpWindowPast'
        ) ?? 0,
        this.configService.get<number>(
          'microservices.saas.security.totpWindowFuture'
        ) ?? 0,
      ],
      keyEncoder,
      keyDecoder,
      createDigest,
      createRandomBytes,
    });
  }

  async login({
    ipAddress,
    userAgent,
    email,
    password,
    code,
    origin,
    googleLogin,
  }: {
    ipAddress: string;
    userAgent: string;
    email: string;
    password?: string;
    code?: string;
    origin?: string;
    googleLogin?: boolean;
  }): Promise<TokenResponse | TotpTokenResponse> {
    const emailSafe = safeEmail(email);
    const user = await this.prisma.user.findFirstOrThrow({
      where: {emails: {some: {emailSafe}}},
      include: {
        emails: true,
        prefersEmail: true,
      },
    });

    if (!user.active)
      await this.prisma.user.update({
        where: {id: user.id},
        data: {active: true},
      });
    if (!user.emails.find(i => i.emailSafe === emailSafe)?.isVerified)
      throw new UnauthorizedException(UNVERIFIED_EMAIL);
    // if (!password || !user.password) return this.mfaResponse(user, 'EMAIL');
    if (!user.prefersEmail) throw new BadRequestException(NO_EMAILS);
    if (!googleLogin && !(await compare(password, user.password)))
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    if (code)
      return this.loginUserWithTotpCode(
        ipAddress,
        userAgent,
        user.id,
        code,
        origin
      );
    if (user.twoFactorMethod !== 'NONE') return this.mfaResponse(user);
    await this.checkLoginSubnet(
      ipAddress,
      userAgent,
      user.checkLocationOnLogin,
      user.id,
      origin
    );
    return this.loginResponse(ipAddress, userAgent, user);
  }

  async register(ipAddress: string, _data: RegisterDto): Promise<Expose<User>> {
    const {email, origin, ...data} = _data;
    const emailSafe = safeEmail(email);
    const testUser = await this.prisma.user.findFirst({
      where: {emails: {some: {emailSafe}}},
    });
    if (testUser) throw new ConflictException(EMAIL_USER_CONFLICT);
    // const ignorePwnedPassword = !!data.ignorePwnedPassword;
    const ignorePwnedPassword = true;
    delete data.ignorePwnedPassword;

    if (data.name)
      data.name = data.name
        .split(' ')
        .map((word, index) =>
          index === 0 || index === data.name.split(' ').length
            ? (word.charAt(0) ?? '').toUpperCase() +
              (word.slice(1) ?? '').toLowerCase()
            : word
        )
        .join(' ');
    if (data.password)
      data.password = await this.hashAndValidatePassword(
        data.password,
        ignorePwnedPassword
      );
    let initials = data.name.trim().substring(0, 2).toUpperCase();
    if (data.name.includes(' '))
      initials = data.name
        .split(' ')
        .map(i => i.trim().substring(0, 1))
        .join('')
        .toUpperCase();
    data.profilePictureUrl =
      data.profilePictureUrl ??
      `https://ui-avatars.com/api/?name=${initials}&background=${randomColor({
        luminosity: 'light',
      }).replace('#', '')}&color=000000`;

    if (!data.gender) {
      try {
        const prediction = await axios.get<{
          name: string;
          gender: 'male' | 'female';
          probability: number;
          count: number;
        }>(`https://api.genderize.io/?name=${data.name.split(' ')[0]}`);
        if (
          prediction.data.probability > 0.5 &&
          prediction.data.gender === 'male'
        )
          data.gender = 'MALE';
        if (
          prediction.data.probability > 0.5 &&
          prediction.data.gender === 'female'
        )
          data.gender = 'FEMALE';
      } catch (error) {}
    }

    if (
      this.configService.get<boolean>('microservices.saas.gravatar.enabled')
    ) {
      for await (const emailString of [email, emailSafe]) {
        const md5Email = createHash('md5').update(emailString).digest('hex');
        try {
          const img = await axios.get(
            `https://www.gravatar.com/avatar/${md5Email}?d=404`,
            {responseType: 'arraybuffer'}
          );

          if (img.data.byteLength > 1)
            data.profilePictureUrl = `https://www.gravatar.com/avatar/${md5Email}?d=mp`;
        } catch (error) {}
      }
    }

    let id: number | undefined = undefined;
    while (!id) {
      id = Number(`10${await generateRandomString(6, 'numeric')}`);
      const users = await this.prisma.user.findMany({where: {id}, take: 1});
      if (users.length) id = undefined;
    }
    const user = await this.prisma.user.create({
      data: {
        ...data,
        id,
        emails: {
          create: {email: email, emailSafe},
        },
      },
      include: {emails: {select: {id: true}}},
    });
    if (user.emails[0]?.id)
      await this.prisma.user.update({
        where: {id: user.id},
        data: {prefersEmail: {connect: {id: user.emails[0].id}}},
      });
    // In testing, we auto-approve the email
    if (process.env.TEST) {
      const emailId = user.emails[0]?.id;
      if (emailId)
        await this.prisma.email.update({
          where: {id: emailId},
          data: {isVerified: true},
        });
    } else await this.sendEmailVerification(email, false, origin);
    await this.approvedSubnetsService.approveNewSubnet(user.id, ipAddress);
    return expose(user);
  }

  async findOrCreateAccountByGoogleAuth({
    googleId,
    firstName,
    lastName,
    email,
    avatar,
  }: {
    googleId: string;
    firstName: string;
    lastName: string;
    email: string;
    avatar: string;
  }): Promise<User> {
    if (!googleId) {
      throw new BadRequestException('missing googleId');
    }
    const userMatchedWithGoogleId = await this.prisma.user.findFirst({
      where: {
        googleId,
      },
      include: {emails: true},
    });
    if (userMatchedWithGoogleId) {
      return userMatchedWithGoogleId;
    }

    const userMatchedWithEmail = await this.prisma.email.findFirst({
      where: {
        email,
      },
    });
    if (userMatchedWithEmail) {
      await this.prisma.user.update({
        where: {id: userMatchedWithEmail.userId},
        data: {
          googleId,
        },
      });
      return await this.prisma.user.findFirstOrThrow({
        where: {
          googleId,
        },
        include: {emails: true},
      });
    }

    // register new user
    let id: number | undefined = undefined;
    while (!id) {
      id = Number(`10${await generateRandomString(6, 'numeric')}`);
      const users = await this.prisma.user.findMany({where: {id}, take: 1});
      if (users.length) id = undefined;
    }
    const user = await this.prisma.user.create({
      data: {
        id,
        name: email,
        googleId,
        profilePictureUrl: avatar,
        emails: {
          create: {email: email, emailSafe: email, isVerified: true},
        },
      },
      include: {emails: true},
    });
    if (user.emails[0]?.id)
      await this.prisma.user.update({
        where: {id: user.id},
        data: {prefersEmail: {connect: {id: user.emails[0].id}}},
      });

    return user;
  }

  async sendEmailVerification(email: string, resend = false, origin?: string) {
    const emailSafe = safeEmail(email);
    const emailDetails = await this.prisma.email.findFirst({
      where: {emailSafe},
      include: {user: true},
    });
    if (!emailDetails) throw new NotFoundException(USER_NOT_FOUND);
    if (emailDetails.isVerified)
      throw new ConflictException(EMAIL_VERIFIED_CONFLICT);
    this.email.sendWithTemplate({
      toAddress: `"${emailDetails.user.name}" <${email}>`,
      template: resend
        ? {
            'auth/resend-email-verification': {
              userName: emailDetails.user.name,
              link: `${
                origin ??
                this.configService.get<string>('microservices.app.frontendUrl')
              }/auth/link/verify-email?token=${this.tokensService.signJwt(
                EMAIL_VERIFY_TOKEN,
                {id: emailDetails.id},
                '7d'
              )}`,
              linkValidDays: 7,
            },
          }
        : {
            'auth/email-verification': {
              userName: emailDetails.user.name,
              link: `${
                origin ??
                this.configService.get<string>('microservices.app.frontendUrl')
              }/auth/link/verify-email?token=${this.tokensService.signJwt(
                EMAIL_VERIFY_TOKEN,
                {id: emailDetails.id},
                '7d'
              )}`,
              linkValidDays: 7,
            },
          },
    });
    return {queued: true};
  }

  async refresh(
    ipAddress: string,
    userAgent: string,
    token: string
  ): Promise<TokenResponse> {
    if (!token) throw new UnprocessableEntityException(NO_TOKEN_PROVIDED);
    const session = await this.prisma.session.findFirst({
      where: {token},
      include: {user: true},
    });
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    await this.prisma.session.updateMany({
      where: {token},
      data: {ipAddress, userAgent},
    });
    return {
      accessToken: await this.getAccessToken(session.user, session.id),
      refreshToken: token,
    };
  }

  async logout(token: string): Promise<void> {
    if (!token) throw new UnprocessableEntityException(NO_TOKEN_PROVIDED);
    const session = await this.prisma.session.findFirst({
      where: {token},
      select: {id: true, user: {select: {id: true}}},
    });
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    await this.prisma.session.delete({
      where: {id: session.id},
    });
  }

  async approveSubnet(
    ipAddress: string,
    userAgent: string,
    token: string
  ): Promise<TokenResponse> {
    if (!token) throw new UnprocessableEntityException(NO_TOKEN_PROVIDED);
    const {id} = this.tokensService.verify<{id: number}>(
      APPROVE_SUBNET_TOKEN,
      token
    );
    const user = await this.prisma.user.findUnique({where: {id}});
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    await this.approvedSubnetsService.approveNewSubnet(id, ipAddress);
    return this.loginResponse(ipAddress, userAgent, user);
  }

  /**
   * Get the two-factor authentication QR code
   * @returns Data URI string with QR code image
   */
  async getTotpQrCode(userId: number): Promise<string> {
    const secret = this.authenticator.generateSecret();
    await this.prisma.user.update({
      where: {id: userId},
      data: {twoFactorSecret: secret},
    });
    const otpauth = this.authenticator.keyuri(
      userId.toString(),
      this.configService.get<string>('microservices.saas.app.name') ?? '',
      secret
    );
    return qrcode.toDataURL(otpauth);
  }

  /** Enable two-factor authentication */
  async enableMfaMethod(
    method: MfaMethod,
    userId: number,
    code: string
  ): Promise<Expose<User>> {
    const user = await this.prisma.user.findUnique({
      where: {id: userId},
      select: {twoFactorSecret: true, twoFactorMethod: true},
    });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    if (user.twoFactorMethod !== 'NONE')
      throw new ConflictException(MFA_ENABLED_CONFLICT);
    if (!user.twoFactorSecret)
      user.twoFactorSecret = this.authenticator.generateSecret();
    if (!this.authenticator.check(code, user.twoFactorSecret))
      throw new UnauthorizedException(INVALID_MFA_CODE);
    const result = await this.prisma.user.update({
      where: {id: userId},
      data: {twoFactorMethod: method, twoFactorSecret: user.twoFactorSecret},
    });
    return expose<User>(result);
  }

  async loginWithTotp(
    ipAddress: string,
    userAgent: string,
    token: string,
    code: string,
    origin?: string
  ): Promise<TokenResponse> {
    const {id} = this.tokensService.verify<MfaTokenPayload>(
      MULTI_FACTOR_TOKEN,
      token
    );
    return this.loginUserWithTotpCode(ipAddress, userAgent, id, code, origin);
  }

  async loginWithEmailToken(
    ipAddress: string,
    userAgent: string,
    token: string
  ): Promise<TokenResponse> {
    const {id} = this.tokensService.verify<MfaTokenPayload>(
      EMAIL_MFA_TOKEN,
      token
    );
    const user = await this.prisma.user.findUnique({where: {id}});
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    await this.approvedSubnetsService.upsertNewSubnet(id, ipAddress);
    return this.loginResponse(ipAddress, userAgent, user);
  }

  async requestPasswordReset(email: string, origin?: string) {
    const emailSafe = safeEmail(email);
    const emailDetails = await this.prisma.email.findFirst({
      where: {emailSafe},
      include: {user: true},
    });
    if (!emailDetails) throw new NotFoundException(USER_NOT_FOUND);
    this.email.sendWithTemplate({
      toAddress: `"${emailDetails.user.name}" <${email}>`,
      template: {
        'auth/password-reset': {
          userName: emailDetails.user.name,
          link: `${
            origin ??
            this.configService.get<string>('microservices.app.frontendUrl')
          }/auth/link/reset-password?token=${this.tokensService.signJwt(
            PASSWORD_RESET_TOKEN,
            {id: emailDetails.user.id},
            '30m'
          )}`,
          linkValidMinutes: 30,
        },
      },
    });
    return {queued: true};
  }

  async resetPassword(
    ipAddress: string,
    userAgent: string,
    token: string,
    password: string,
    ignorePwnedPassword?: boolean
  ): Promise<TokenResponse> {
    const {id} = this.tokensService.verify<{id: number}>(
      PASSWORD_RESET_TOKEN,
      token
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: {id},
      include: {prefersEmail: true},
    });

    password = await this.hashAndValidatePassword(
      password,
      !!ignorePwnedPassword
    );
    await this.prisma.user.update({where: {id}, data: {password}});
    await this.approvedSubnetsService.upsertNewSubnet(id, ipAddress);

    if (user.prefersEmail) {
      this.email.sendWithTemplate({
        toAddress: `"${user.name}" <${user.prefersEmail.email}>`,
        template: {'users/password-changed': {userName: user.name}},
      });
    }

    return this.loginResponse(ipAddress, userAgent, user);
  }

  async verifyEmail(
    ipAddress: string,
    userAgent: string,
    token: string,
    origin?: string
  ): Promise<TokenResponse> {
    const {id} = this.tokensService.verify<{id: number}>(
      EMAIL_VERIFY_TOKEN,
      token
    );
    const result = await this.prisma.email.update({
      where: {id},
      data: {isVerified: true},
      include: {user: true},
    });
    const teamsToJoin = await this.prisma.team.findMany({
      where: {
        autoJoinDomain: true,
        domains: {
          some: {isVerified: true, domain: result.emailSafe.split('@')[1]},
        },
      },
      select: {id: true, name: true},
    });
    for await (const team of teamsToJoin) {
      await this.prisma.membership.create({
        data: {
          user: {connect: {id: result.user.id}},
          team: {connect: {id: team.id}},
          role: 'MEMBER',
        },
      });
      this.email.sendWithTemplate({
        toAddress: `"${result.user.name}" <${result.email}>`,
        template: {
          'teams/invitation': {
            userName: result.user.name,
            teamName: team.name,
            link: `${
              origin ??
              this.configService.get<string>('microservices.app.frontendUrl')
            }/teams/${team.id}`,
          },
        },
      });
    }
    return this.loginResponse(ipAddress, userAgent, result.user);
  }

  getOneTimePassword(secret: string): string {
    return this.authenticator.generate(secret);
  }

  private async loginUserWithTotpCode(
    ipAddress: string,
    userAgent: string,
    id: number,
    code: string,
    origin?: string
  ): Promise<TokenResponse> {
    const user = await this.prisma.user.findUnique({
      where: {id},
      include: {prefersEmail: true},
    });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    if (user.twoFactorMethod === 'NONE' || !user.twoFactorSecret)
      throw new BadRequestException(MFA_NOT_ENABLED);
    if (this.authenticator.check(code, user.twoFactorSecret))
      return this.loginResponse(ipAddress, userAgent, user);
    const backupCodes = await this.prisma.backupCode.findMany({
      where: {user: {id}},
    });
    let usedBackupCode = false;
    for await (const backupCode of backupCodes) {
      if (await compare(code, backupCode.code)) {
        if (!usedBackupCode) {
          if (backupCode.isUsed)
            throw new UnauthorizedException(MFA_BACKUP_CODE_USED);
          usedBackupCode = true;
          await this.prisma.backupCode.update({
            where: {id: backupCode.id},
            data: {isUsed: true},
          });
          const location = await this.geolocationService.getLocation(ipAddress);
          const locationName =
            [
              location?.city?.names?.en,
              (location?.subdivisions ?? [])[0]?.names?.en,
              location?.country?.names?.en,
            ]
              .filter(i => i)
              .join(', ') || 'Unknown location';
          if (user.prefersEmail)
            this.email.sendWithTemplate({
              toAddress: `"${user.name}" <${user.prefersEmail.email}>`,
              template: {
                'auth/used-backup-code': {
                  userName: user.name,
                  locationName,
                  link: `${
                    origin ??
                    this.configService.get<string>(
                      'microservices.app.frontendUrl'
                    )
                  }/users/${id}/sessions`,
                },
              },
            });
        }
      }
    }
    if (!usedBackupCode) throw new UnauthorizedException(INVALID_MFA_CODE);
    return this.loginResponse(ipAddress, userAgent, user);
  }

  private async getAccessToken(user: User, sessionId: number): Promise<string> {
    const scopes = await this.getScopes(user);
    const payload: AccessTokenClaims = {
      id: user.id,
      sessionId,
      scopes,
      role: user.role,
    };
    return this.tokensService.signJwt(
      LOGIN_ACCESS_TOKEN,
      payload,
      this.configService.get<string>(
        'microservices.saas.security.accessTokenExpiry'
      )
    );
  }

  private async loginResponse(
    ipAddress: string,
    userAgent: string,
    user: User
  ): Promise<TokenResponse> {
    const token = await generateRandomString(64);
    const ua = UAParser(userAgent);
    const location = await this.geolocationService.getLocation(ipAddress);
    const {id} = await this.prisma.session.create({
      data: {
        token,
        ipAddress,
        city: location?.city?.names?.en,
        region: location?.subdivisions?.pop()?.names?.en,
        timezone: location?.location?.time_zone,
        countryCode: location?.country?.iso_code,
        userAgent,
        browser:
          `${ua.browser.name ?? ''} ${ua.browser.version ?? ''}`.trim() ||
          undefined,
        operatingSystem:
          `${ua.os.name ?? ''} ${ua.os.version ?? ''}`
            .replace('Mac OS', 'macOS')
            .trim() || undefined,
        user: {connect: {id: user.id}},
      },
    });
    return {
      accessToken: await this.getAccessToken(user, id),
      refreshToken: token,
    };
  }

  private async mfaResponse(
    user: User & {prefersEmail: Email | null},
    forceMethod?: MfaMethod
  ): Promise<TotpTokenResponse> {
    const mfaTokenPayload: MfaTokenPayload = {
      type: user.twoFactorMethod,
      id: user.id,
    };
    const totpToken = this.tokensService.signJwt(
      MULTI_FACTOR_TOKEN,
      mfaTokenPayload,
      this.configService.get<string>(
        'microservices.saas.security.mfaTokenExpiry'
      )
    );
    if (user.twoFactorMethod === 'EMAIL' || forceMethod === 'EMAIL') {
      if (user.prefersEmail) {
        this.email.sendWithTemplate({
          toAddress: `"${user.name}" <${user.prefersEmail.email}>`,
          template: {
            'auth/login-link': {
              userName: user.name,
              link: `${this.configService.get<string>(
                'microservices.app.frontendUrl'
              )}/auth/link/login%2Ftoken?token=${this.tokensService.signJwt(
                EMAIL_MFA_TOKEN,
                {id: user.id},
                '30m'
              )}`,
              linkValidMinutes: parseInt(
                this.configService.get<string>(
                  'microservices.saas.security.mfaTokenExpiry'
                ) ?? ''
              ),
            },
          },
        });
      }
    } else if (user.twoFactorMethod === 'SMS' || forceMethod === 'SMS') {
      if (!user.twoFactorPhone)
        throw new BadRequestException(MFA_PHONE_NOT_FOUND);

      if (user.twoFactorSecret) {
        this.twilioService.send({
          to: user.twoFactorPhone,
          body: `${this.getOneTimePassword(user.twoFactorSecret)} is your ${
            this.configService.get<string>('microservices.saas.app.name') ?? ''
          } verification code.`,
        });
      }
    }
    return {
      totpToken,
      type: forceMethod || user.twoFactorMethod,
      multiFactorRequired: true,
    };
  }

  private async checkLoginSubnet(
    ipAddress: string,
    _: string, // userAgent
    checkLocationOnLogin: boolean,
    id: number,
    origin?: string
  ): Promise<void> {
    if (!checkLocationOnLogin) return;
    const subnet = anonymize(ipAddress);
    const previousSubnets = await this.prisma.approvedSubnet.findMany({
      where: {user: {id}},
    });
    let isApproved = false;
    for await (const item of previousSubnets) {
      if (!isApproved)
        if (await compare(subnet, item.subnet)) isApproved = true;
    }
    if (!isApproved) {
      const user = await this.prisma.user.findUnique({
        where: {id},
        select: {name: true, prefersEmail: true, checkLocationOnLogin: true},
      });
      if (!user) throw new NotFoundException(USER_NOT_FOUND);
      if (!user.checkLocationOnLogin) return;
      const location = await this.geolocationService.getLocation(ipAddress);
      const locationName =
        [
          location?.city?.names?.en,
          (location?.subdivisions ?? [])[0]?.names?.en,
          location?.country?.names?.en,
        ]
          .filter(i => i)
          .join(', ') || 'Unknown location';
      if (user.prefersEmail)
        this.email.sendWithTemplate({
          toAddress: `"${user.name}" <${user.prefersEmail.email}>`,
          template: {
            'auth/approve-subnet': {
              userName: user.name,
              locationName,
              link: `${
                origin ??
                this.configService.get<string>('microservices.app.frontendUrl')
              }/auth/link/approve-subnet?token=${this.tokensService.signJwt(
                APPROVE_SUBNET_TOKEN,
                {id},
                '30m'
              )}`,
              linkValidMinutes: 30,
            },
          },
        });
      throw new UnauthorizedException(UNVERIFIED_LOCATION);
    }
  }

  async hashAndValidatePassword(
    password: string,
    ignorePwnedPassword: boolean
  ): Promise<string> {
    if (!ignorePwnedPassword) {
      if (
        !this.configService.get<boolean>(
          'microservices.saas.security.passwordPwnedCheck'
        )
      )
        return await hash(
          password,
          this.configService.getOrThrow<number>(
            'microservices.saas.security.saltRounds'
          )
        );
      if (!(await this.pwnedService.isPasswordSafe(password)))
        throw new BadRequestException(COMPROMISED_PASSWORD);
    }
    return await hash(
      password,
      this.configService.getOrThrow<number>(
        'microservices.saas.security.saltRounds'
      )
    );
  }

  /** Get logging in scopes for a user */
  async getScopes(user: User): Promise<string[]> {
    // Superadmins can do anything
    if (user.role === 'SUDO') return ['*'];

    // Add all scopes for user self
    const scopes: string[] = Object.keys({
      ...userScopes,
      ...userScopesCustomized,
    }).map(scope => scope.replace('{userId}', user.id.toString()));

    // Add scopes for teams user is part of
    const memberships = await this.prisma.membership.findMany({
      where: {user: {id: user.id}},
      select: {id: true, role: true, team: {select: {id: true}}},
    });

    for await (const membership of memberships) {
      scopes.push(`membership-${membership.id}:*`);
      const id = membership.team.id;

      if (membership.role === 'OWNER')
        scopes.push(
          ...Object.keys(teamOwnerScopes).map(i =>
            i.replace('{teamId}', id.toString())
          )
        );
      if (membership.role === 'ADMIN')
        scopes.push(
          ...Object.keys(teamAdminScopes).map(i =>
            i.replace('{teamId}', id.toString())
          )
        );
      if (membership.role === 'MEMBER')
        scopes.push(
          ...Object.keys(teamMemberScopes).map(i =>
            i.replace('{teamId}', id.toString())
          ),
          ...Object.keys(teamMemberScopesCustomized).map(i =>
            i.replace('{teamId}', id.toString())
          )
        );
    }
    return scopes;
  }

  async mergeUsers(token: string): Promise<{success: true}> {
    let baseUserId: number | undefined = undefined;
    let mergeUserId: number | undefined = undefined;
    try {
      const result = this.tokensService.verify<{
        baseUserId: number;
        mergeUserId: number;
      }>(MERGE_ACCOUNTS_TOKEN, token);
      baseUserId = result.baseUserId;
      mergeUserId = result.mergeUserId;
    } catch (error) {}
    if (!baseUserId || !mergeUserId)
      throw new BadRequestException(USER_NOT_FOUND);
    return this.merge(baseUserId, mergeUserId);
  }

  private async merge(
    baseUserId: number,
    mergeUserId: number
  ): Promise<{success: true}> {
    const baseUser = await this.prisma.user.findUnique({
      where: {id: baseUserId},
    });
    const mergeUser = await this.prisma.user.findUnique({
      where: {id: mergeUserId},
    });
    if (!baseUser || !mergeUser) throw new NotFoundException(USER_NOT_FOUND);

    const combinedUser: Record<string, any> = {};
    [
      'checkLocationOnLogin',
      'countryCode',
      'gender',
      'name',
      'notificationEmails',
      'active',
      'prefersLanguage',
      'prefersColorScheme',
      'prefersReducedMotion',
      'profilePictureUrl',
      'role',
      'timezone',
      'twoFactorMethod',
      'twoFactorPhone',
      'twoFactorSecret',
      'attributes',
    ].forEach(key => {
      if (mergeUser[key] != null) combinedUser[key] = mergeUser[key];
    });
    await this.prisma.user.update({
      where: {id: baseUserId},
      data: combinedUser,
    });

    for await (const dataType of [
      this.prisma.membership,
      this.prisma.email,
      this.prisma.session,
      this.prisma.approvedSubnet,
      this.prisma.backupCode,
      this.prisma.identity,
      this.prisma.auditLog,
      this.prisma.apiKey,
    ] as Prisma.EmailDelegate[]) {
      for await (const item of await (
        dataType as Prisma.EmailDelegate
      ).findMany({
        where: {user: {id: mergeUserId}},
        select: {id: true},
      }))
        await (dataType as Prisma.EmailDelegate).update({
          where: {id: item.id},
          data: {user: {connect: {id: baseUserId}}},
        });
    }

    await this.prisma.user.delete({where: {id: mergeUser.id}});
    return {success: true};
  }
}
