# Running migrations in production

How the shops run the tool, so that changes keep working for them.

## The nightly job

Each shop's store lives on its own server. A nightly job runs, in this order:

```sh
node bin/migrate.js status /srv/store        # logged, to see where it starts from
node bin/migrate.js run /srv/store           # to the latest schema
node bin/migrate.js verify /srv/store        # the backup job only copies stores that verify
```

The job does not look at the output of `run`, only at the exit code. It is killed when it runs over its
time slot, and servers are rebooted for updates at any time of the night, so a run can be stopped
anywhere. The next night's job then simply runs the same commands again; nobody repairs a store by hand.
That is why docs/RESUME.md asks for so much.

## Backups

The backup job copies a store only when `verify` exits with 0, and keeps the last seven copies. A copy
restored from backup must be accepted by `run` as it is: at the latest schema with a matching manifest, the
run does nothing.

## Quarantine

Quarantine files are read by the support team, who fix records by hand in the shop system and send them
again in the next export. They rely on:

- the reason strings, exactly as MIGRATIONS.md lists them (they filter on them);
- the `step` field, to know which schema the quarantined `record` is in;
- entries never being rewritten or removed by a migration.

## Several stores at once

Stores are independent folders; the tool never writes outside the store it was given (everything goes
through `src/store/fsx.js` relative to it), so several migrations can run side by side on one server.
