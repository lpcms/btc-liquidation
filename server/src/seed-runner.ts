/**
 * Seed CLI.
 *
 *   node dist/seed-runner.js export   live database -> data/liquidations.csv.gz
 *   node dist/seed-runner.js import   data/liquidations.csv.gz -> live database
 *
 * Export merges newly collected or imported liquidations into the committed
 * archive; it never removes rows from it. Import loads the archive into the
 * local database, for example to view the full history on the chart.
 */

import { openDatabase, Repository } from './db.js';
import { DB_PATH, SEED_PATH } from './dbpath.js';
import { exportSeed, importSeed } from './seed.js';

/**
 * Entry point: dispatches on the command argument and prints a summary.
 */
function main(): void {
    const command = process.argv[2];
    if (command !== 'export' && command !== 'import') {
        process.stderr.write('Usage: node dist/seed-runner.js <export|import>\n');
        process.exit(1);
        return;
    }

    const db = openDatabase(DB_PATH);
    const repo = new Repository(db);

    if (command === 'export') {
        const { total, added } = exportSeed(repo, SEED_PATH);
        process.stdout.write(`Merged ${added} new liquidations into ${SEED_PATH} (${total} in total)\n`);
    } else {
        const { read, added } = importSeed(repo, SEED_PATH);
        process.stdout.write(`Read ${read} liquidations from ${SEED_PATH}, added ${added} new.\n`);
    }

    db.close();
}

main();
