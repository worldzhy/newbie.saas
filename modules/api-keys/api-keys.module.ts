import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import {ElasticsearchModule} from '../../providers/elasticsearch/elasticsearch.module';

import {TokensModule} from '../../providers/tokens/tokens.module';
import {ApiKeyTeamController} from './api-keys-team.controller';
import {ApiKeyUserController} from './api-keys-user.controller';
import {ApiKeysService} from './api-keys.service';

@Module({
  imports: [TokensModule, ConfigModule, ElasticsearchModule],
  controllers: [ApiKeyTeamController, ApiKeyUserController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
