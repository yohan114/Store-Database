# Backup & Restore

The server takes an automatic, **non-blocking** backup of the SQLite database
every 30 minutes (an online `db.backup()` copy that never freezes the app the
way the old `copyFileSync` did). Backups are written to `backups/` next to the
database as `inventory_backup_<timestamp>.db`.

## Retention (tiered)

Pruning keeps recent granularity without unbounded growth:

| Age of backup        | What is kept                         |
|----------------------|--------------------------------------|
| < 24 hours           | **every** backup (48/day)            |
| 1 – 30 days          | **one per calendar day**             |
| > 30 days            | deleted                              |

So you always have half-hourly points for the last day, then a daily point for
the last month.

## What is backed up

The `.db` file only. With WAL mode the live database has `inventory.db-wal` /
`inventory.db-shm` sidecars; `db.backup()` (and the `node:sqlite` fallback,
which first runs `PRAGMA wal_checkpoint(TRUNCATE)`) produces a **single,
self-contained** `.db` — you never need the sidecars from a backup.

## Restore

1. **Stop the server** (nothing may be writing to the database during a
   restore).
2. In the project directory, remove the live WAL/SHM sidecars if present so they
   can't replay stale pages over the restored file:
   ```
   rm -f inventory.db-wal inventory.db-shm
   ```
3. Copy the chosen backup over the live database:
   ```
   cp backups/inventory_backup_<timestamp>.db inventory.db
   ```
4. **Start the server.** On boot it re-applies WAL mode and runs the versioned
   migrations (idempotent — a restored older file is brought up to the current
   `PRAGMA user_version` automatically).

To inspect a backup without overwriting anything, point the server at it via the
`INVENTORY_DB` environment variable instead of copying:

```
INVENTORY_DB=backups/inventory_backup_<timestamp>.db npm start
```

## Notes

- `backups/` is git-ignored — backups contain live data (password hashes,
  session tokens) and must never be committed.
- Schema changes are versioned with `PRAGMA user_version`; restoring a backup
  from an older schema version is safe because each migration runs exactly once
  and is forward-only.
