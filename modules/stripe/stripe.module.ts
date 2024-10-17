import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import {RawBodyMiddleware} from '@framework/middlewares/raw-body.middleware';

import {StripeBillingController} from './stripe-billing.controller';
import {StripeWebhookController} from './stripe-webhook.controller';
import {StripeSubscriptionController} from './stripe-subscription.controller';
import {StripeSourcesController} from './stripe-sources.controller';
import {StripeInvoicesController} from './stripe-invoices.controller';
import {StripeService} from './stripe.service';

@Module({
  imports: [ConfigModule],
  providers: [StripeService],
  exports: [StripeService],
  controllers: [
    StripeBillingController,
    StripeInvoicesController,
    StripeSourcesController,
    StripeSubscriptionController,
    StripeWebhookController,
  ],
})
export class StripeModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RawBodyMiddleware).forRoutes({
      path: '/webhooks/stripe',
      method: RequestMethod.POST,
    });
  }
}
