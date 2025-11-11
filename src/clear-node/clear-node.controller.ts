import {Controller} from "@nestjs/common";
import {ClearNodeService} from "./clear-node.service";

@Controller({})
export class ClearNodeController {
    constructor(private readonly clearNodeService: ClearNodeService) {
    }
}