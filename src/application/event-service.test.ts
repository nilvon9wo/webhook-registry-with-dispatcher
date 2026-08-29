import { describe, expect, it } from 'vitest';
import { captureRejection } from '../../tests/support/capture-error.js';
import { ValidationError } from '../domain/errors.js';
import type { WebhookEvent } from '../domain/event.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import { InMemoryEventRepository } from '../infrastructure/memory/in-memory-repositories.js';
import { silentLogger } from './logging.js';
import { fixedClock } from './clock.js';
import { EventService, type EventDispatcher } from './event-service.js';
import type { EventRepository } from './ports.js';

const CLOCK = fixedClock(new Date('2026-08-28T10:15:00.000Z'));

function sequentialIds(): IdGenerator {
  let n = 0;
  return {
    next: (kind: IdKind) => {
      n += 1;
      return `${kind}_${n}`;
    },
  };
}

class SpyDispatcher implements EventDispatcher {
  readonly dispatched: WebhookEvent[] = [];
  dispatch(event: WebhookEvent): void {
    this.dispatched.push(event);
  }
}

interface Harness {
  readonly service: EventService;
  readonly repository: InMemoryEventRepository;
  readonly dispatcher: SpyDispatcher;
}

function newHarness(): Harness {
  const repository = new InMemoryEventRepository();
  const dispatcher = new SpyDispatcher();
  const service = new EventService({
    repository,
    dispatcher,
    clock: CLOCK,
    ids: sequentialIds(),
    logger: silentLogger,
  });
  return { service, repository, dispatcher };
}

describe('EventService.ingest', () => {
  it('assigns an id and ISO timestamp and returns the event', async () => {
    // Arrange
    const { service } = newHarness();

    // Act
    const event = await service.ingest({ type: 'order.created', data: { orderId: '12345' } });

    // Assert
    expect(event).toEqual({
      id: 'event_1',
      type: 'order.created',
      data: { orderId: '12345' },
      createdAt: '2026-08-28T10:15:00.000Z',
    });
  });

  it('persists the event before returning', async () => {
    // Arrange
    const { service, repository } = newHarness();

    // Act
    const event = await service.ingest({ type: 'order.created' });

    // Assert
    expect(await repository.get(event.id)).toEqual(event);
  });

  it('initiates dispatch exactly once with the persisted event', async () => {
    // Arrange
    const { service, dispatcher } = newHarness();

    // Act
    const event = await service.ingest({ type: 'order.created' });

    // Assert
    expect(dispatcher.dispatched).toEqual([event]);
  });

  it('persists before it dispatches', async () => {
    // Arrange
    const calls: string[] = [];
    const inner = new InMemoryEventRepository();
    const repository: EventRepository = {
      save: async (event) => {
        calls.push('save');
        await inner.save(event);
      },
      get: (id) => inner.get(id),
    };
    const service = new EventService({
      repository,
      dispatcher: { dispatch: () => calls.push('dispatch') },
      clock: CLOCK,
      ids: sequentialIds(),
      logger: silentLogger,
    });

    // Act
    await service.ingest({ type: 'order.created' });

    // Assert
    expect(calls).toEqual(['save', 'dispatch']);
  });

  it('rejects an invalid body without persisting or dispatching', async () => {
    // Arrange
    const { service, repository, dispatcher } = newHarness();

    // Act
    const error = await captureRejection(service.ingest({ data: { orderId: '1' } }));

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
    expect(dispatcher.dispatched).toHaveLength(0);
    expect(await repository.get('event_1')).toBeUndefined();
  });
});
