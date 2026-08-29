import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/test-app.js';

let app: TestApp;

beforeEach(async () => {
  app = await startTestApp();
});

afterEach(async () => {
  await app.close();
});

describe('API documentation routes', () => {
  it('serves the OpenAPI document as YAML', async () => {
    // Arrange — the process runs from the repo root, where openapi.yaml lives.

    // Act
    const response = await fetch(`${app.baseUrl}/openapi.yaml`);

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('yaml');
    expect(await response.text()).toContain('openapi: 3.0.3');
  });

  it('serves a Swagger UI HTML page at /docs', async () => {
    // Arrange — none.

    // Act
    const response = await fetch(`${app.baseUrl}/docs`);

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('swagger-ui');
    expect(html).toContain("url: '/openapi.yaml'");
  });
});
