import { Injectable } from '@nestjs/common';

@Injectable()
export class RequestIdService {
  private counter = 0;

  nextId(): number {
    return ++this.counter;
  }
}
