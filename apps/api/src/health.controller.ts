// Liveness/readiness probe for the API.
//
//   GET /health -> { status: 'ok' }
//
// Intentionally dependency-free: it does NOT touch the database or Ollama. Its
// only job is to answer "is the HTTP server up and accepting requests?" so that
// compose healthchecks and the e2e smoke can gate on the API being reachable.
// Readiness of the DB/Ollama is gated separately by compose `depends_on` +
// per-service healthchecks (db, ollama) — not by this endpoint.

import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
