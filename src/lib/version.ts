import packageJson from '../../package.json';

/**
 * The single source of truth for the app version is package.json's "version" field —
 * the same field install/update.sh and install/update.ps1 read before and after an update.
 *
 * This is a BUILD-TIME import, not a runtime file read, and that is deliberate: the Docker
 * runtime ships Next's standalone output, whose working directory is not the project root,
 * so `fs.readFileSync('package.json')` there would either miss or (worse) find Next's own
 * generated standalone package.json. Importing the JSON lets the bundler inline the literal,
 * so the constant is correct in dev, in tests, and in the container alike.
 */
export const APP_VERSION: string = packageJson.version;
