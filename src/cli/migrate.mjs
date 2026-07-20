import { CURRENT_VERSION, DatabaseMigrationError, migrateDefaultDb } from '../db.mjs';

export const MIGRATION_SCHEMA = 'throughline.database_migration.v1';

export function parseArgs(argv = []) {
  if (argv.length !== 1 || argv[0] !== '--json') throw new TypeError('usage error');
  return { json: true };
}

function result({ status, beforeSchemaVersion, afterSchemaVersion }) {
  return {
    schema: MIGRATION_SCHEMA,
    status,
    beforeSchemaVersion,
    afterSchemaVersion,
    supportedSchemaVersion: CURRENT_VERSION,
  };
}

export function run(argv = [], { stdout = process.stdout, migrate = migrateDefaultDb } = {}) {
  try {
    parseArgs(argv);
  } catch {
    stdout.write(`${JSON.stringify(result({
      status: 'invalid_request', beforeSchemaVersion: null, afterSchemaVersion: null,
    }))}\n`);
    return 2;
  }

  try {
    stdout.write(`${JSON.stringify(result(migrate()))}\n`);
    return 0;
  } catch (error) {
    const failure = error instanceof DatabaseMigrationError
      ? error
      : new DatabaseMigrationError('migration_failed', null, null);
    stdout.write(`${JSON.stringify(result({
      status: failure.code,
      beforeSchemaVersion: failure.beforeSchemaVersion,
      afterSchemaVersion: failure.afterSchemaVersion,
    }))}\n`);
    return 1;
  }
}
