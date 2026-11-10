// Which Supabase project this page talks to (ARC-326).
//
// Every page loads this file before anything that uses Supabase. It sets
// window.LAUNCHPAD_ENV = { name, supabaseUrl, supabaseKey, appUrl }.
//
//   production  the live site (sty4a-launch-pad.vercel.app, the main branch
//               alias, or any custom domain)
//   test        local runs (localhost, 127.0.0.1, LAN addresses) and Vercel
//               preview deployments of other branches
//
// Until the test project's URL and anon key are filled in below, test pages
// keep using production, as they always have. Once they are, test pages show
// a "TEST DATA" badge and nothing they save reaches the live data.
// See README section 4 and docs/adr/0006-test-environment.md.
//
// Both keys are the public anon keys, which are meant to be in browser code.
// Never put a service key here.
(function () {
    var PRODUCTION = {
        name: 'production',
        supabaseUrl: 'https://rcnxetcomdrlxvlarqoc.supabase.co',
        supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjbnhldGNvbWRybHh2bGFycW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDIyMjksImV4cCI6MjA5MjAxODIyOX0.gP37sT5OrCOVRZXekMrBZHm5mtfnr6JrC2YGflWsDQU',
        appUrl: 'https://sty4a-launch-pad.vercel.app/'
    };
    var TEST = {
        name: 'test',
        supabaseUrl: '', // e.g. https://<test-project-ref>.supabase.co
        supabaseKey: '', // the test project's anon (public) key
        appUrl: window.location.origin + '/'
    };
    var PRODUCTION_HOSTS = ['sty4a-launch-pad.vercel.app'];

    function isTestHost(host) {
        host = String(host || '').toLowerCase();
        if (PRODUCTION_HOSTS.indexOf(host) !== -1) return false;
        if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host)) return true;
        if (/^(10|192\.168)\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || /\.local$/.test(host)) return true;
        // Vercel previews. The main branch alias deploys production.
        if (/\.vercel\.app$/.test(host)) return host.indexOf('-git-main-') === -1;
        // Any other host (a custom domain) is the live site.
        return false;
    }

    var wantsTest = isTestHost(window.location.hostname);
    var testReady = !!(TEST.supabaseUrl && TEST.supabaseKey);
    var env = wantsTest && testReady ? TEST : PRODUCTION;
    if (wantsTest && !testReady) {
        console.warn('LaunchPad: no test database is set up in env.js, so this page uses the PRODUCTION data. Read-only testing only.');
    }
    window.LAUNCHPAD_ENV = Object.freeze(env);
    window.LAUNCHPAD_ENV_IS_TEST_HOST = isTestHost; // for checks

    if (env.name === 'test') {
        var showBadge = function () {
            if (document.getElementById('lp-test-env-badge')) return;
            var b = document.createElement('div');
            b.id = 'lp-test-env-badge';
            b.textContent = 'TEST DATA';
            b.title = 'This page uses the LaunchPad test database. Nothing here changes the live data.';
            b.setAttribute('role', 'status');
            b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:4px 10px;' +
                'border-radius:999px;background:#b45309;color:#fff;font:600 12px/1.4 Roboto,"Segoe UI",sans-serif;' +
                'letter-spacing:.06em;box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:none;';
            document.body.appendChild(b);
        };
        if (document.body) showBadge();
        else document.addEventListener('DOMContentLoaded', showBadge);
    }
})();
