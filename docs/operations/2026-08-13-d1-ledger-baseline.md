# D1 migration ledger baseline — 2026-08-13

Target: `torudake-reel-db` (`c0b9cc06-fc19-4e02-acac-2c19d32f3fdc`)

The production schema already contained the effects of migrations 0000 through
0019, but `d1_migrations` contained zero rows. Before recording the filenames:

- all migrations were applied in order to a fresh local D1 database;
- 179 application columns matched production exactly;
- 79 application indexes matched in name, column order, uniqueness and origin;
- production `PRAGMA quick_check` returned `ok`;
- production `PRAGMA foreign_key_check` returned zero rows;
- the pre-change Time Travel bookmark was
  `00000070-00000000-000050c6-29cca6174db5d017f4ce3ce158ee12d5`;
- the D-drive export was saved as
  `D:\CodexTemp\torudake-runtime-temp\torudake-reel-db-before-ledger-baseline-20260813.sql`;
- its SHA-256 was
  `AA35F8DF75D89FC8D4528A9755C0DD5A567A0B69B8CA78BBC7BF3E20C3BBA0BA`.

The one-time SQL in
`scripts/operations/baseline-d1-migration-ledger-0000-0019.sql` then inserted
only the 20 already-applied migration filenames. No application table, index or
business row was changed. The post-change bookmark was
`00000070-00000006-000050c6-b2b3367b050e038f2d9966c6fb2df5c4`.

Postflight results:

- `d1_migrations`: 20 rows in 0000–0019 order;
- `PRAGMA quick_check`: `ok`;
- `PRAGMA foreign_key_check`: zero rows;
- `wrangler d1 migrations list`: no migrations to apply.

The baseline SQL is an audit artifact and must not be executed again.
