#!/usr/bin/env node
// Builds the LaunchPad TEST database (ARC-326).
//
// Copies the STRUCTURE of production's public schema (tables, functions,
// policies, grants; no rows) into the test Supabase project, then adds the
// fake TEMPLATE and DEMO projects from test-env/seed.sql. It only reads
// production. Nothing from production's data is copied.
//
// Needs the PostgreSQL client tools (pg_dump and psql, version 17 or newer)
// on the PATH, and both projects' database connection strings, from
// Supabase -> Connect -> "Session pooler" (they include the database
// password, so keep them in environment variables, never in a file here):
//
//   LP_PROD_DB_URL   production connection string (read only)
//   LP_TEST_DB_URL   test project connection string
//
// Usage:
//   node test-env/setup-test-db.mjs --template <prefix> --owner <email> [--reset]
//
//   --template  table prefix of a production project to copy the structure
//               of, e.g. the prefix of your most up-to-date project
//   --owner     your LaunchPad sign-in email (platform owner + demo admin)
//   --reset     wipe the test database's public schema first. Needed when
//               re-copying the structure; refused if it has real projects.
//
// See README section 4 and docs/adr/0006-test-environment.md.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROD_REF = 'rcnxetcomdrlxvlarqoc';
const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
    const out = { reset: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--reset') out.reset = true;
        else if (a === '--template') out.template = argv[++i];
        else if (a === '--owner') out.owner = argv[++i];
        else throw new Error(`Unknown option ${a}`);
    }
    if (!out.template || !/^[A-Za-z][A-Za-z0-9_]*$/.test(out.template)) throw new Error('--template <table prefix> is required (letters, digits, _).');
    if (!out.owner || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.owner)) throw new Error('--owner <your sign-in email> is required.');
    return out;
}

// The test connection must never be production.
export function checkUrls(prodUrl, testUrl) {
    if (!prodUrl) throw new Error('Set LP_PROD_DB_URL to the production connection string.');
    if (!testUrl) throw new Error('Set LP_TEST_DB_URL to the test project connection string.');
    if (testUrl.includes(PROD_REF)) throw new Error('LP_TEST_DB_URL points at the PRODUCTION project. Stopping.');
    if (!prodUrl.includes(PROD_REF)) throw new Error('LP_PROD_DB_URL is not the production project. Stopping.');
    if (prodUrl === testUrl) throw new Error('LP_PROD_DB_URL and LP_TEST_DB_URL are the same. Stopping.');
}

// Lines of a schema dump that would clash with what every Supabase project
// already has.
export function cleanDump(sql) {
    return sql.split(/\r?\n/).filter(line =>
        !/^CREATE SCHEMA public;/.test(line) &&
        !/^COMMENT ON SCHEMA public /.test(line) &&
        !/^ALTER SCHEMA public OWNER /.test(line) &&
        !/^CREATE PUBLICATION /.test(line) &&
        !/^SET transaction_timeout/.test(line)
    ).join('\n');
}

function run(cmd, args, { input, quiet } = {}) {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw new Error(`Could not run ${cmd}: ${r.error.message}. Install the PostgreSQL client tools (17+) and add them to PATH.`);
    if (!quiet && r.stdout) process.stdout.write(r.stdout);
    return r;
}

function psql(url, args, opts) {
    return run('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], opts);
}

function scalar(url, sql) {
    const r = psql(url, ['-tA', '-c', sql], { quiet: true });
    if (r.status !== 0) throw new Error(r.stderr.trim());
    return r.stdout.trim();
}

const RESET_SQL = `
drop schema public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
`;

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const prodUrl = process.env.LP_PROD_DB_URL, testUrl = process.env.LP_TEST_DB_URL;
    checkUrls(prodUrl, testUrl);
    for (const t of ['pg_dump', 'psql']) {
        const v = run(t, ['--version'], { quiet: true });
        if (v.status !== 0) throw new Error(`${t} --version failed: ${v.stderr}`);
        console.log(v.stdout.trim());
    }

    // 1. What's in the test database now.
    const hasRegistry = scalar(testUrl, `select to_regclass('public.launchpad_projects') is not null`) === 't';
    if (hasRegistry) {
        const real = Number(scalar(testUrl, `select count(*) from public.launchpad_projects where project_key not in ('TEMPLATE', 'DEMO')`));
        if (real > 0) throw new Error(`The test database has ${real} real project(s) in it. Is LP_TEST_DB_URL really the test project? Stopping.`);
    }
    const tables = Number(scalar(testUrl, `select count(*) from pg_tables where schemaname = 'public'`));
    if (tables > 0 && !opts.reset) {
        throw new Error(`The test database already has ${tables} table(s). Re-run with --reset to wipe it and copy the structure again.`);
    }

    // 2. Production's structure, no rows, into a temp file outside the repo.
    const dir = mkdtempSync(join(tmpdir(), 'lp-test-db-'));
    const dumpFile = join(dir, 'schema.sql');
    try {
        console.log('Reading the production structure (no rows)...');
        const d = run('pg_dump', [prodUrl, '--schema-only', '--schema=public', '--no-owner', '-f', dumpFile], { quiet: true });
        if (d.status !== 0) throw new Error(`pg_dump failed: ${d.stderr}`);
        writeFileSync(dumpFile, cleanDump(readFileSync(dumpFile, 'utf8')));

        if (tables > 0) {
            console.log('Wiping the test database public schema (--reset)...');
            const r = psql(testUrl, ['-c', RESET_SQL]);
            if (r.status !== 0) throw new Error(`Reset failed: ${r.stderr}`);
        }

        console.log('Loading the structure into the test database...');
        const l = run('psql', [testUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=0', '-f', dumpFile], { quiet: true });
        const errors = (l.stderr || '').split(/\r?\n/).filter(x => /ERROR/.test(x));
        if (errors.length) {
            console.log(`${errors.length} statement(s) did not load (often harmless, e.g. something Supabase already has):`);
            errors.slice(0, 30).forEach(e => console.log('  ' + e));
        }

        console.log('Adding the TEMPLATE and DEMO projects...');
        const s = psql(testUrl, ['-v', `template_prefix=${opts.template}`, '-v', `owner_email=${opts.owner}`, '-f', join(HERE, 'seed.sql')]);
        if (s.status !== 0) throw new Error(`seed.sql failed: ${s.stderr}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(`
Done. Next:
  1. Supabase (test project) -> Authentication -> Users -> Add user: ${opts.owner}, with a password.
  2. Authentication -> URL Configuration: Site URL http://localhost:3000; add Redirect URLs
     http://localhost:*/** and https://sty4a-launch-pad-*.vercel.app/**
  3. Put the test project URL and anon key in env.js (TEST).
  4. npx serve .  -> sign in -> pick "Demo project". The TEST DATA badge shows in the corner.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => { console.error('\n' + e.message); process.exit(1); });
}
