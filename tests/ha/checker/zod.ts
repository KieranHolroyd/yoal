/**
 * tests/ha is not a workspace package, so it has no node_modules of its own. zod comes from the
 * contracts package's install (the same version the platform uses).
 */
export { z } from '../../../packages/contracts/node_modules/zod';
