/**
 * Vitest `globalSetup` for the integration suite.
 *
 * Boots the docker-compose stack under `infra/analytics-minio/` before
 * any test file loads and tears it down when the whole run finishes.
 * Waits until MinIO's admin endpoint and the Iceberg REST catalog's
 * `/v1/config` respond 200 — matches the health check expectations
 * baked into the compose file.
 *
 * Iteration escape hatch: setting `INTEGRATION_STACK_EXTERNAL=1` tells
 * this hook to skip both `up` and `down`, so a developer can leave the
 * stack running between test runs (see the infra README for the local
 * loop). CI uses this flag too because the CI job manages compose
 * lifecycle directly.
 *
 * Vitest supports either a default-exported function or the
 * `{ setup, teardown }` object form; we use the object form so the
 * teardown can independently opt out of the external-stack path.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE_DIR = resolve(HERE, '../../../infra/analytics-minio')
const COMPOSE = 'docker-compose.yml'

const MINIO_READY_URL = 'http://localhost:9000/minio/health/ready'
const REST_CONFIG_URL = 'http://localhost:8181/v1/config'

const WAIT_TIMEOUT_MS = 60_000
const WAIT_INTERVAL_MS = 500

function isExternal(): boolean {
  return process.env.INTEGRATION_STACK_EXTERNAL === '1'
}

function compose(...args: string[]): void {
  const res = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], {
    cwd: COMPOSE_DIR,
    stdio: 'inherit',
    encoding: 'utf-8',
  })
  if (res.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited ${res.status}`)
  }
}

async function waitForOk(url: string): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    }
    catch (e) {
      lastErr = e
    }
    await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`)
}

export async function setup(): Promise<void> {
  if (isExternal()) {
    // Trust the external orchestrator; still verify endpoints so a
    // typo'd port surfaces here instead of inside a test.
    await waitForOk(MINIO_READY_URL)
    await waitForOk(REST_CONFIG_URL)
    return
  }
  compose('up', '-d', '--wait')
  await waitForOk(MINIO_READY_URL)
  await waitForOk(REST_CONFIG_URL)
}

export async function teardown(): Promise<void> {
  if (isExternal()) return
  compose('down', '-v')
}
