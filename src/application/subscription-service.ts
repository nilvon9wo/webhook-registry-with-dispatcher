/**
 * Subscription use cases.
 *
 * Orchestrates validation, id/timestamp assignment, and persistence for the
 * `/subscriptions` resource. Knows nothing about HTTP.
 */

import type { IdGenerator } from '../domain/ids.js';
import type { TargetUrlPolicy } from '../domain/target-url.js';
import {
  createSubscription,
  parseSubscriptionInput,
  replaceSubscription,
  type Subscription,
} from '../domain/subscription.js';
import type { Clock } from './clock.js';
import { ResourceNotFoundError } from './errors.js';
import type { SubscriptionListFilter, SubscriptionRepository } from './ports.js';

export interface SubscriptionServiceDeps {
  readonly repository: SubscriptionRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly targetUrlPolicy: TargetUrlPolicy;
}

export class SubscriptionService {
  private readonly repository: SubscriptionRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly targetUrlPolicy: TargetUrlPolicy;

  constructor(deps: SubscriptionServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.targetUrlPolicy = deps.targetUrlPolicy;
  }

  /** Validates the body and persists a new subscription. Throws ValidationError on bad input. */
  async create(body: unknown): Promise<Subscription> {
    const input = parseSubscriptionInput(body, this.targetUrlPolicy);
    const subscription = createSubscription(input, this.ids.next('subscription'), this.clock.now());
    await this.repository.save(subscription);
    return subscription;
  }

  async get(id: string): Promise<Subscription> {
    const found = await this.repository.get(id);
    if (found === undefined) {
      throw new ResourceNotFoundError('subscription', id);
    }
    return found;
  }

  async list(filter: SubscriptionListFilter = {}): Promise<Subscription[]> {
    return this.repository.list(filter);
  }

  /**
   * Full replace for `PUT /subscriptions/{id}`. Throws {@link ResourceNotFoundError}
   * if the id is unknown (ids are server-generated, so there is nothing to upsert).
   */
  async replace(id: string, body: unknown): Promise<Subscription> {
    const existing = await this.repository.get(id);
    if (existing === undefined) {
      throw new ResourceNotFoundError('subscription', id);
    }
    const input = parseSubscriptionInput(body, this.targetUrlPolicy);
    const updated = replaceSubscription(existing, input, this.clock.now());
    await this.repository.save(updated);
    return updated;
  }

  /** Throws {@link ResourceNotFoundError} if the id is unknown. */
  async delete(id: string): Promise<void> {
    const existed = await this.repository.delete(id);
    if (!existed) {
      throw new ResourceNotFoundError('subscription', id);
    }
  }
}
