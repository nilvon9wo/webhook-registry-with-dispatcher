/**
 * Delivery read use cases for the `/deliveries` API (bonus). Read-only: delivery
 * state is written only by the dispatcher and recovery.
 */

import type { Delivery } from '../domain/delivery.js';
import { ResourceNotFoundError } from './errors.js';
import type { DeliveryListFilter, DeliveryRepository } from './ports.js';

export class DeliveryService {
  constructor(private readonly repository: DeliveryRepository) {}

  async get(id: string): Promise<Delivery> {
    const found = await this.repository.get(id);
    if (found === undefined) {
      throw new ResourceNotFoundError('delivery', id);
    }
    return found;
  }

  async list(filter: DeliveryListFilter): Promise<Delivery[]> {
    return this.repository.list(filter);
  }
}
