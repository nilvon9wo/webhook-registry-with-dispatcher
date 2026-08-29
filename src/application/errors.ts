/**
 * Application-layer errors. Independent of HTTP; the HTTP layer maps them to
 * status codes.
 */

export class ResourceNotFoundError extends Error {
  readonly resource: string;
  readonly id: string;

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = 'ResourceNotFoundError';
    this.resource = resource;
    this.id = id;
  }
}
