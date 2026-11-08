'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const src = fs.readFileSync(path.join(__dirname, '../deploy/nginx/connect.openvibe.website.conf'), 'utf8');
for (const domain of ['website', 'link']) {
    assert.ok(src.includes(`server_name connect.openvibe.${domain};`));
    assert.ok(src.includes(`server_name ~^[a-z0-9-]+--[a-z0-9-]+\\.openvibe\\.${domain}$;`));
    assert.ok(src.includes(`/etc/letsencrypt/live/openvibe.${domain}/fullchain.pem;`));
}
assert.equal((src.match(/location = \/tunnel/g) || []).length, 2);
assert.equal((src.match(/proxy_request_buffering off/g) || []).length, 2);
assert.equal((src.match(/limit_req_zone .*zone=connect_auth/g) || []).length, 1);
assert.doesNotMatch(src, /server_name\s+\*\.openvibe\.link/, 'only share names go to Connect; apex stays Network');
try { execFileSync('nginx', ['-v'], { stdio: 'pipe' }); } catch {
    console.log('nginx-link: routing assertions passed; nginx syntax check skipped (nginx unavailable)');
    process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-nginx-'));
try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', `${dir}/test.key`, '-out', `${dir}/test.pem`], { stdio: 'pipe' });
    const config = src.replace(/include snippets\/security-txt\.conf;/g, '')
        .replace(/ssl_certificate\s+[^;]+;/g, `ssl_certificate ${dir}/test.pem;`)
        .replace(/ssl_certificate_key\s+[^;]+;/g, `ssl_certificate_key ${dir}/test.key;`)
        .replace(/\/var\/log\/nginx\/[^ ;]+/g, '/dev/null');
    fs.writeFileSync(`${dir}/nginx.conf`, `pid ${dir}/nginx.pid;\nerror_log /dev/null;\nevents {}\nhttp {\n${config}\n}\n`);
    execFileSync('nginx', ['-t', '-p', dir, '-c', `${dir}/nginx.conf`], { cwd: dir, stdio: 'pipe' });
    console.log('nginx-link: dual-host routing and nginx -t passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
