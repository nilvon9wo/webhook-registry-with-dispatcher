/**
 * Event ingestion use case.
 *
 * `POST /events` flow (spec section 3 / 8):
 *
 *   validate → assign id + timestamp → persist → initiate async dispatch → 202
 *
 * The event is persisted *before* dispatch is initiated so that an accepted
 * event is never lost if the process crashes mid-dispatch. Dispatch itself is
 * fire-and-forget: the HTTP response must not wait on subscriber latency.
 */

import { createEvent, parseEventInput, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator } from '../domain/ids.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Clock } from './clock.js';
import type { EventRepository } from './ports.js';

export interface EventDispatcher {
  /**
   * Begins asynchronous delivery of `event` to matching subscribers.
   *
   * MUST return promptly and MUST NOT throw or reject into the caller: the event
   * is already durably persisted, and the HTTP response must not depend on
   * subscriber availability. Implementations own their background work and error
   * handling.
   */
  dispatch(event: WebhookEvent): void;
}

export interface EventServiceDeps {
  readonly repository: EventRepository;
  readonly dispatcher: EventDispatcher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

export class EventService {
  private readonly repository: EventRepository;
  private readonly dispatcher: EventDispatcher;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: EventServiceDeps) {
    this.repository = deps.repository;
    this.dispatcher = deps.dispatcher;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.logger = deps.logger;
  }

  /**
   * Validates the body, persists the event, then initiates asynchronous
   * dispatch. Resolves as soon as the event is durable — not when delivery
   * completes. Throws {@link ValidationError} on a bad body (nothing persisted).
   */
  async ingest(body: unknown): Promise<WebhookEvent> {
    const input = parseEventInput(body);
    const event = createEvent(input, this.ids.next('event'), this.clock.now());

    await this.repository.save(event);
    this.logger.info('event accepted', { eventId: event.id, type: event.type });

    this.dispatcher.dispatch(event);
    return event;
  }
}
