/**
 * `GET /openapi.yaml` serves the OpenAPI document; `GET /docs` serves a Swagger
 * UI page for it (loaded from a CDN — needs internet; the raw `openapi.yaml`
 * file works offline in any API client).
 *
 * The spec text is read once at startup from `openapi.yaml` in the working
 * directory (both `npm start` and `npm run dev` run from the repo root). If it
 * cannot be read, the routes still exist but report that.
 */

import type { Router } from '../router.js';

const SWAGGER_UI_VERSION = '5.17.14';

function swaggerUiPage(): string {
  const base = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Webhook Registry API</title>
    <link rel="stylesheet" href="${base}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${base}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
      });
    </script>
  </body>
</html>
`;
}

export function registerDocsRoutes(router: Router, openapiYaml: string | undefined): void {
  router.add('GET', '/openapi.yaml', () => {
    if (openapiYaml === undefined) {
      return {
        status: 503,
        body: { error: { message: 'openapi.yaml is not available (run from the repo root)' } },
      };
    }
    return {
      status: 200,
      headers: { 'Content-Type': 'application/yaml' },
      rawBody: openapiYaml,
    };
  });

  router.add('GET', '/docs', () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    rawBody: swaggerUiPage(),
  }));
}
