import {Module} from "@nestjs/common";
import {ClearNodeController} from "./clear-node.controller";
import {ClearNodeService} from "./clear-node.service";
import {ConfigService} from "@nestjs/config";

@Module({
    controllers: [ClearNodeController],
    providers: [ClearNodeService, ConfigService]
})
export class ClearNodeModule {
}