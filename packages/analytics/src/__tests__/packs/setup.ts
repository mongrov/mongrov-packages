/**
 * Registers the test packs before every suite. The engine is domain-free;
 * its suites exercise it with a realistic pack — a copy of the health and
 * ring packs as they were moved to zivaone_app (`@zivaone/health`,
 * `@zivaone/ring`) in package-separation S-03. The real packs and their own
 * tests live there; this copy is a fixture (principle 73 allows test packs
 * under `__tests__/packs/`).
 */
import { setDefaultPacks } from '../../core/packs'
import { DEFAULT_PACKS } from './index'

setDefaultPacks(DEFAULT_PACKS)
