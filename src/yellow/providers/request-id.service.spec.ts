import { RequestIdService } from './request-id.service';

describe('RequestIdService', () => {
  let service: RequestIdService;

  beforeEach(() => {
    service = new RequestIdService();
  });

  it('should return incrementing IDs starting from 1', () => {
    expect(service.nextId()).toBe(1);
    expect(service.nextId()).toBe(2);
    expect(service.nextId()).toBe(3);
  });

  it('should never return the same ID twice', () => {
    const ids = new Set<number>();
    for (let i = 0; i < 100; i++) {
      ids.add(service.nextId());
    }
    expect(ids.size).toBe(100);
  });
});
