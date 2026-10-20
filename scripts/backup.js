// Run on the server: node scripts/backup.js /absolute/path/to/backup.sqlite
// SQLite's online backup includes WAL writes; copying only the .sqlite file is unsafe.
import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
const destination = process.argv[2];
if (!destination) throw new Error('Provide a backup destination outside the live data directory.');
const source=resolve(process.env.DATA_DIR||'.data','mawayid.sqlite');
if(resolve(destination)===source)throw new Error('Backup destination must differ from the live database.');
const db = new DatabaseSync(source);
try { await backup(db, destination); console.log('Database backup completed.'); } finally { db.close(); }
