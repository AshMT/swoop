/**
 * Single source of the app version.
 *
 * Read from package.json at build time rather than duplicated as a literal, so
 * the health endpoint and the UI footer cannot disagree with the release tag.
 */
import pkg from '../package.json';

export const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';
