import { Module } from '@nestjs/common';
import {ClearNodeModule} from "./clear-node/clear-node.module";
import {ConfigModule} from "@nestjs/config";

@Module({
  imports: [ClearNodeModule, ConfigModule.forRoot({isGlobal: true})],
})
export class AppModule {}
