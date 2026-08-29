import { describe, expect, it } from 'vitest';
import { captureRejection } from '../../tests/support/capture-error.js';
import { aDelivery } from '../../tests/support/factories.js';
import { InMemoryDeliveryRepository } from '../infrastructure/memory/in-memory-repositories.js';
import { DeliveryService } from './delivery-service.js';
import { ResourceNotFoundError } from './errors.js';

function newService(): { service: DeliveryService; repository: InMemoryDeliveryRepository } {
  const repository = new InMemoryDeliveryRepository();
  return { service: new DeliveryService(repository), repository };
}

describe('DeliveryService.get', () => {
  it('returns a stored delivery', async () => {
    // Arrange
    const { service, repository } = newService();
    const delivery = aDelivery({ id: 'del_1' });
    await repository.save(delivery);

    // Act
    const found = await service.get('del_1');

    // Assert
    expect(found).toEqual(delivery);
  });

  it('throws ResourceNotFoundError for an unknown id', async () => {
    // Arrange
    const { service } = newService();

    // Act
    const error = await captureRejection(service.get('del_missing'));

    // Assert
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('DeliveryService.list', () => {
  it('passes the filter through to the repository', async () => {
    // Arrange
    const { service, repository } = newService();
    await repository.save(aDelivery({ eventId: 'evt_1', status: 'failed' }));
    await repository.save(aDelivery({ eventId: 'evt_1', status: 'delivered' }));
    await repository.save(aDelivery({ eventId: 'evt_2', status: 'failed' }));

    // Act
    const result = await service.list({ eventId: 'evt_1', status: 'failed' });

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('evt_1');
    expect(result[0]?.status).toBe('failed');
  });
});
