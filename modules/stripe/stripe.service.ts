import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import Stripe from 'stripe';
import {
  BILLING_ACCOUNT_CREATED_CONFLICT,
  BILLING_NOT_FOUND,
  CUSTOMER_NOT_FOUND,
  GROUP_NOT_FOUND,
  INVOICE_NOT_FOUND,
  SOURCE_NOT_FOUND,
  SUBSCRIPTION_NOT_FOUND,
} from '../../errors/errors.constants';
import {PrismaService} from '@framework/prisma/prisma.service';

@Injectable()
export class StripeService {
  stripe: Stripe;
  logger = new Logger(StripeService.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService
  ) {
    const stripeApiKey = this.configService.getOrThrow<string>(
      'microservices.saas.payments.stripeApiKey'
    );
    this.stripe = new Stripe(stripeApiKey, {
      apiVersion: '2024-06-20',
    });
  }

  async createCustomer(teamId: number, data: Stripe.CustomerCreateParams) {
    const team = await this.prisma.team.findUnique({
      where: {id: teamId},
      select: {attributes: true},
    });
    if (!team) throw new NotFoundException(GROUP_NOT_FOUND);
    const attributes = team.attributes as {stripeCustomerId?: string};
    if (attributes?.stripeCustomerId)
      throw new ConflictException(BILLING_ACCOUNT_CREATED_CONFLICT);
    const result = await this.stripe.customers.create(data);
    await this.prisma.team.update({
      where: {id: teamId},
      data: {attributes: {stripeCustomerId: result.id}},
    });
    return result as Stripe.Response<Stripe.Customer>;
  }

  async getCustomer(teamId: number) {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.customers.retrieve(stripeId);
    if (result.deleted) throw new NotFoundException(CUSTOMER_NOT_FOUND);
    return result as Stripe.Response<Stripe.Customer>;
  }

  async updateCustomer(teamId: number, data: Stripe.CustomerUpdateParams) {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.customers.update(stripeId, data);
    return result as Stripe.Response<Stripe.Customer>;
  }

  async deleteCustomer(teamId: number): Promise<Stripe.DeletedCustomer> {
    const stripeId = await this.stripeId(teamId);
    const result = (await this.stripe.customers.del(
      stripeId
    )) as Stripe.DeletedCustomer;
    await this.prisma.team.update({
      where: {id: teamId},
      data: {attributes: {stripeCustomerId: null}},
    });
    return result;
  }

  async getBillingPortalLink(
    teamId: number
  ): Promise<Stripe.Response<Stripe.BillingPortal.Session>> {
    const stripeId = await this.stripeId(teamId);
    return this.stripe.billingPortal.sessions.create({
      customer: stripeId,
      return_url: `${this.configService.get<string>(
        'microservices.app.frontendUrl'
      )}/teams/${teamId}`,
    });
  }

  async getInvoices(
    teamId: number,
    params: {
      take?: number;
      cursor?: {id: string};
    }
  ): Promise<Stripe.Invoice[]> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.invoices.list({
      customer: stripeId,
      limit: params.take,
      starting_after: params.cursor?.id,
    });
    return this.list<Stripe.Invoice>(result);
  }

  async getInvoice(teamId: number, invoiceId: string): Promise<Stripe.Invoice> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.invoices.retrieve(invoiceId);
    if (result.customer !== stripeId)
      throw new NotFoundException(INVOICE_NOT_FOUND);
    return result;
  }

  async getSubscriptions(
    teamId: number,
    params: {
      take?: number;
      cursor?: {id: string};
    }
  ): Promise<Stripe.Subscription[]> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.subscriptions.list({
      customer: stripeId,
      limit: params.take,
      starting_after: params.cursor?.id,
    });
    return this.list<Stripe.Subscription>(result);
  }

  async getSubscription(
    teamId: number,
    subscriptionId: string
  ): Promise<Stripe.Subscription> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.subscriptions.retrieve(subscriptionId);
    if (result.customer !== stripeId)
      throw new NotFoundException(SUBSCRIPTION_NOT_FOUND);
    return result;
  }

  async getSources(
    teamId: number,
    params: {
      take?: number;
      cursor?: {id: string};
    }
  ): Promise<Stripe.CustomerSource[]> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.customers.listSources(stripeId, {
      limit: params.take,
      starting_after: params.cursor?.id,
    });
    return this.list<Stripe.CustomerSource>(result);
  }

  async getSource(teamId: number, sourceId: string): Promise<Stripe.Source> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.sources.retrieve(sourceId);
    if (result.customer !== stripeId)
      throw new NotFoundException(SOURCE_NOT_FOUND);
    return result;
  }

  async deleteSource(teamId: number, sourceId: string): Promise<void> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.sources.retrieve(sourceId);
    if (result.customer !== stripeId)
      throw new NotFoundException(SOURCE_NOT_FOUND);
    await this.stripe.customers.deleteSource(stripeId, sourceId);
  }

  async createSession(
    teamId: number,
    mode: Stripe.Checkout.SessionCreateParams.Mode,
    planId?: string
  ): Promise<Stripe.Checkout.Session> {
    const stripeId = await this.stripeId(teamId);
    const data: Stripe.Checkout.SessionCreateParams = {
      customer: stripeId,
      mode,
      payment_method_types: this.configService.get<
        Array<Stripe.Checkout.SessionCreateParams.PaymentMethodType>
      >('microservices.saas.payments.paymentMethodTypes') ?? ['card'],
      success_url: `${this.configService.get<string>(
        'microservices.app.frontendUrl'
      )}/teams/${teamId}`,
      cancel_url: `${this.configService.get<string>(
        'microservices.app.frontendUrl'
      )}/teams/${teamId}`,
    };
    if (mode === 'subscription')
      data.line_items = [{quantity: 1, price: planId}];
    const result = await this.stripe.checkout.sessions.create(data);
    return result;
  }

  async cancelSubscription(
    teamId: number,
    subscriptionId: string
  ): Promise<Stripe.Subscription> {
    const stripeId = await this.stripeId(teamId);
    const result = await this.stripe.subscriptions.retrieve(subscriptionId);
    if (result.customer !== stripeId)
      throw new NotFoundException(SUBSCRIPTION_NOT_FOUND);
    return this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async plans(teamId: number, product?: string): Promise<Stripe.Plan[]> {
    const stripeId = await this.stripeId(teamId);
    const plans = await this.stripe.plans.list({product});
    return plans.data.filter(plan => {
      let show = true;
      ['special', 'internal'].forEach(word => {
        if (plan.nickname!.toLowerCase().includes(word)) show = false;
      });
      const tokens = plan
        .nickname!.toLowerCase()
        .replace(/[^a-zA-Z0-9]/g, ' ')
        .replace(/\s\s+/g, ' ')
        .split(' ');
      [stripeId, teamId.toString()].forEach(word => {
        if (tokens.includes(word)) show = true;
      });
      return show;
    });
  }

  async handleWebhook(
    signature: string,
    payload: Buffer
  ): Promise<{received: true}> {
    const event = this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.configService.get<string>(
        'microservices.saas.payments.stripeEndpointSecret'
      ) ?? ''
    );
    switch (event.type) {
      default:
        this.logger.warn(`Unhandled event type ${event.type}`);
    }
    return {received: true};
  }

  private list<T>(result: Stripe.Response<Stripe.ApiList<T>>) {
    return result.data;
  }

  /** Get the Stripe customer ID from a team or throw an error */
  private async stripeId(teamId: number): Promise<string> {
    const team = await this.prisma.team.findUnique({
      where: {id: teamId},
      select: {attributes: true},
    });
    if (!team) throw new NotFoundException(GROUP_NOT_FOUND);
    const attributes = team.attributes as {stripeCustomerId?: string};
    if (!attributes?.stripeCustomerId)
      throw new BadRequestException(BILLING_NOT_FOUND);
    return attributes.stripeCustomerId;
  }
}
