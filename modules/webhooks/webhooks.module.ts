import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';

import {WebhookController} from './webhooks.controller';
import {WebhooksService} from './webhooks.service';

@Module({
  imports: [ConfigModule],
  controllers: [WebhookController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
