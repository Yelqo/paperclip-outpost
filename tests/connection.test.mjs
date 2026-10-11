import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { versions } from '../plugin/versions.ts';

const home = mkdtempSync(join(tmpdir(), 'outpost-access-'));
const workspace = join(home, 'workspaces'), scratch = join(home, 'scratch');
const headers = {'CF-Access-Client-Id':'existing-service-id', 'CF-Access-Client-Secret':'existing-service-secret'};
let server, sockets, origin;
let requireAccess = true;
let redirectTo;
let registrationHandler;
let rejectDuplicateConnections = false;
const requests = [];

function cli(args, input, stopWhenConnected = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.cwd(), 'bin/outpost'), args, {
      env:{...process.env, SSL_CERT_FILE:join(home, 'cert.pem')}, stdio:['pipe','pipe','pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('CLI timed out'));},15000);
    child.stdout.on('data', data => {
      stdout += data;
      if (stopWhenConnected && stdout.includes('"status":"connected"')) child.kill('SIGTERM');
    });
    child.stderr.on('data', data => {stderr += data;});
    child.on('error', reject);
    child.on('close', code => {clearTimeout(timer); resolve({code, stdout, stderr});});
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
const configure = (dir, values = headers) => cli(['configure','--instance',origin,'--private-dir',dir,
  '--workspace-root',workspace,'--scratch-root',scratch], {headers:values});
const register = dir => cli(['register','--private-dir',dir,'--company','fixture-company','--name','Access worker'],
  {operatorAuthorization:'Bearer operator-secret'});

before(async () => {
  mkdirSync(workspace); mkdirSync(scratch);
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-keyout',join(home,'key.pem'),'-out',join(home,'cert.pem'),'-subj','/CN=127.0.0.1',
    '-addext','subjectAltName=IP:127.0.0.1'], {stdio:'ignore'});
  const authenticate = req => !requireAccess || Object.entries(headers).every(([key, value]) => req.headers[key.toLowerCase()] === value);
  server = createServer({key:readFileSync(join(home,'key.pem')),cert:readFileSync(join(home,'cert.pem'))}, async (req,res) => {
    requests.push({path:req.url, headers:req.headers});
    if (redirectTo) {res.writeHead(302,{Location:redirectTo}); return res.end();}
    if (!authenticate(req)) {res.writeHead(403); return res.end('denied existing-service-secret');}
    res.setHeader('Content-Type','application/json');
    if (req.url === '/api/health') return res.end('{"status":"ok"}');
    if (req.headers.authorization !== 'Bearer operator-secret') {res.writeHead(401); return res.end('denied');}
    if (req.url.endsWith('/api/outposts')) {
      if (registrationHandler) return registrationHandler(req,res);
      return res.end(JSON.stringify({outpostId:'fixture-outpost',credential:'outpost-machine-secret',versions}));
    }
    if (req.url.endsWith('/environments')) return res.end('{"id":"fixture-environment"}');
    res.writeHead(404); res.end('{}');
  });
  sockets = new WebSocketServer({noServer:true});
  server.on('upgrade', (req,socket,head) => {
    requests.push({path:req.url, headers:req.headers});
    if (redirectTo) return socket.end(`HTTP/1.1 302 Found\r\nLocation: ${redirectTo}\r\nContent-Length: 0\r\n\r\n`);
    if (!authenticate(req)) return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    if (req.headers.authorization !== 'Bearer outpost-machine-secret') return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    if (rejectDuplicateConnections && sockets.clients.size > 0) return socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n');
    sockets.handleUpgrade(req,socket,head,ws => {
      ws.send(JSON.stringify({type:'ready',outpostId:'fixture-outpost',companyId:'fixture-company',versions}));
      ws.on('message', () => ws.send('{"type":"pong","operations":[]}'));
    });
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  origin = `https://127.0.0.1:${server.address().port}`;
});

test('failed access authentication is actionable and corrected local settings restore registration and daemon connections', async () => {
  const dir = join(home,'correction');
  assert.equal((await configure(dir, {...headers,'CF-Access-Client-Secret':'wrong-secret'})).code,0);
  const failed = await cli(['check','--private-dir',dir]);
  assert.equal(failed.code,1);
  assert.match(failed.stderr,/HTTP 403.*access credentials/);
  const denied = await register(dir);
  assert.equal(denied.code,1);
  assert.match(denied.stderr,/HTTP 403.*access credentials/);
  const bypass = await cli(['register','--private-dir',dir,'--company','fixture-company','--name','Bypass'],
    {operatorAuthorization:'Bearer operator-secret',headers});
  assert.equal(bypass.code,1);
  assert.match(bypass.stderr,/configure/);
  assert.equal((await cli(['configure','--private-dir',dir],{headers})).code,0);
  assert.equal((await register(dir)).code,0);
  const identity = JSON.parse((await cli(['diagnose','--private-dir',dir])).stdout);
  assert.equal((await cli(['configure','--private-dir',dir],{headers:{...headers,'CF-Access-Client-Secret':'wrong-secret'}})).code,0);
  for (const command of ['check','connect','daemon']) {
    const rejected = await cli([command,'--private-dir',dir]);
    assert.equal(rejected.code,1);
    assert.match(rejected.stderr,/HTTP 403.*access credentials/);
    assert.ok(!rejected.stderr.includes('wrong-secret'));
    assert.ok(!rejected.stderr.includes(headers['CF-Access-Client-Secret']));
  }
  assert.equal((await cli(['configure','--private-dir',dir],{headers})).code,0);
  assert.deepEqual(JSON.parse((await cli(['diagnose','--private-dir',dir])).stdout),identity);
  assert.equal((await cli(['check','--private-dir',dir])).code,0);
  const daemon = await cli(['daemon','--private-dir',dir],undefined,true);
  assert.equal(daemon.code,0,daemon.stderr);
  assert.equal(JSON.parse(daemon.stdout).status,'connected');
  assert.equal(statSync(dir).mode & 0o777,0o700);
  assert.equal(statSync(join(dir,'connection.json')).mode & 0o777,0o600);
});
after(async () => {
  for (const ws of sockets.clients) ws.terminate();
  sockets.close(); server.closeAllConnections();
  await new Promise(r => server.close(r));
});

test('operator configures existing access credentials before registration and checks connectivity', async () => {
  const firstRequest = requests.length;
  const dir = join(home,'pre-registration');
  const configured = await configure(dir);
  assert.equal(configured.code,0,configured.stderr);
  assert.match(configured.stdout,/configured/);
  const checked = await cli(['check','--private-dir',dir]);
  assert.equal(checked.code,0,checked.stderr);
  assert.match(checked.stdout,/reachable/);
  const registered = await register(dir);
  assert.equal(registered.code,0,registered.stderr);
  const connected = await cli(['connect','--private-dir',dir]);
  assert.equal(connected.code,0,connected.stderr);
  assert.match(connected.stdout,/connected/);
  for (const request of requests.slice(firstRequest)) {
    for (const [name,value] of Object.entries(headers)) assert.equal(request.headers[name.toLowerCase()],value,request.path);
  }
  const diagnostic = await cli(['diagnose','--private-dir',dir]);
  for (const secret of ['operator-secret','outpost-machine-secret',...Object.values(headers)]) {
    assert.ok(![configured,checked,registered,connected,diagnostic].some(result => (result.stdout+result.stderr).includes(secret)));
  }
});

test('configuration updates and registration accept the same instance origin with a trailing slash', async () => {
  const dir = join(home,'trailing-slash');
  const args = ['configure','--instance',`${origin}/`,'--private-dir',dir,
    '--workspace-root',workspace,'--scratch-root',scratch];
  const configured = await cli(args,{headers:{...headers,'CF-Access-Client-Secret':'wrong-secret'}});
  assert.equal(configured.code,0,configured.stderr);
  const corrected = await cli(args,{headers});
  assert.equal(corrected.code,0,corrected.stderr);
  assert.equal((await cli(['check','--private-dir',dir])).code,0);
  const registered = await cli(['register','--instance',`${origin}/`,'--private-dir',dir,
    '--company','fixture-company','--name','Trailing slash worker'],{operatorAuthorization:'Bearer operator-secret'});
  assert.equal(registered.code,0,registered.stderr);
  const saved = readFileSync(join(dir,'connection.json'),'utf8');
  assert.equal(JSON.parse(saved).instance,origin);
  for (const instance of ['https://different.example.com/','https://user:secret@example.com/']) {
    const requestsBefore = requests.length;
    const invalid = await cli(['configure','--instance',instance,'--private-dir',dir],{headers:{}});
    assert.equal(invalid.code,1);
    assert.equal(readFileSync(join(dir,'connection.json'),'utf8'),saved);
    assert.equal(requests.length,requestsBefore);
    assert.ok(!invalid.stderr.includes('secret'));
  }
  assert.equal((await cli(['check','--private-dir',dir])).code,0);
});

test('checking a connected daemon explains the conflict and succeeds after the daemon stops', async () => {
  const dir = join(home,'active-daemon');
  assert.equal((await configure(dir)).code,0);
  assert.equal((await register(dir)).code,0);
  rejectDuplicateConnections = true;
  const daemon = spawn(join(process.cwd(),'bin/outpost'),['daemon','--private-dir',dir], {
    env:{...process.env,SSL_CERT_FILE:join(home,'cert.pem')},stdio:['ignore','pipe','pipe'],
  });
  const exited = once(daemon,'close');
  const connected = Promise.withResolvers();
  let stdout = '', stderr = '';
  daemon.stdout.on('data',data => {
    stdout += data;
    if (stdout.includes('"status":"connected"')) connected.resolve();
  });
  daemon.stderr.on('data',data => {stderr += data;});
  daemon.on('error',connected.reject);
  daemon.on('close',() => connected.reject(new Error(`Daemon exited before connecting: ${stderr}`)));
  const timer = setTimeout(() => connected.reject(new Error('Daemon connection timed out')),15000);
  let disconnected;
  try {
    await connected.promise;
    assert.equal(sockets.clients.size,1);
    disconnected = once([...sockets.clients][0],'close');
    const competingDir = join(home,'competing-daemon');
    assert.equal((await configure(competingDir)).code,0);
    assert.equal((await register(competingDir)).code,0);
    for (const [command, privateDir] of [['check',dir],['connect',dir],['daemon',competingDir]]) {
      const result = await cli([command,'--private-dir',privateDir]);
      assert.equal(result.code,1);
      assert.match(result.stderr,/already connected.*HTTP 409.*stop.*daemon.*check/);
      assert.doesNotMatch(result.stderr,/access credentials|registration|revocation|configure/);
      for (const secret of ['outpost-machine-secret',...Object.values(headers)]) assert.ok(!result.stderr.includes(secret));
      assert.equal(daemon.exitCode,null,'a rejected connection must leave the daemon connected');
      assert.equal(sockets.clients.size,1);
    }
  } finally {
    clearTimeout(timer);
    daemon.kill('SIGTERM');
    await exited;
    if (disconnected) await disconnected;
    rejectDuplicateConnections = false;
  }
  const checked = await cli(['check','--private-dir',dir]);
  assert.equal(checked.code,0,checked.stderr);
  assert.match(checked.stdout,/connected/);
});

test('ordinary authenticated WSS needs no optional headers and clearing old access settings preserves identity', async () => {
  requireAccess = false;
  try {
    const firstRequest = requests.length;
    const dir = join(home,'ordinary-wss');
    assert.equal((await configure(dir,{})).code,0);
    assert.equal((await cli(['check','--private-dir',dir])).code,0);
    assert.equal((await register(dir)).code,0);
    const daemon = await cli(['daemon','--private-dir',dir],undefined,true);
    assert.equal(daemon.code,0,daemon.stderr);
    assert.equal(JSON.parse(daemon.stdout).status,'connected');
    for (const request of requests.slice(firstRequest)) {
      assert.equal(request.headers['cf-access-client-id'],undefined);
      assert.equal(request.headers['cf-access-client-secret'],undefined);
    }
    const before = JSON.parse((await cli(['diagnose','--private-dir',dir])).stdout);
    assert.equal((await cli(['configure','--private-dir',dir],{headers})).code,0);
    assert.equal((await cli(['configure','--private-dir',dir],{headers:{}})).code,0);
    assert.deepEqual(JSON.parse((await cli(['diagnose','--private-dir',dir])).stdout),before);
    assert.equal((await cli(['connect','--private-dir',dir])).code,0);
  } finally {requireAccess = true;}
});

test('connection checks and authenticated requests reject access redirects without forwarding credentials', async () => {
  const dir = join(home,'redirect');
  assert.equal((await configure(dir)).code,0);
  assert.equal((await register(dir)).code,0);
  let received = 0;
  const destination = createServer({key:readFileSync(join(home,'key.pem')),cert:readFileSync(join(home,'cert.pem'))}, (_req,res) => {
    received++; res.end('{"status":"ok"}');
  });
  await new Promise(r => destination.listen(0,'127.0.0.1',r));
  redirectTo = `https://127.0.0.1:${destination.address().port}/existing-service-secret`;
  try {
    const pending = join(home,'redirect-registration');
    assert.equal((await configure(pending)).code,0);
    for (const [command, privateDir] of [['check',pending],['register',pending],['check',dir],['connect',dir],['daemon',dir]]) {
      const result = command === 'register' ? await register(privateDir) : await cli([command,'--private-dir',privateDir]);
      assert.equal(result.code,1);
      assert.match(result.stderr,/HTTP 302/);
      assert.ok(!result.stderr.includes('existing-service-secret'));
    }
    assert.equal(received,0);
  } finally {
    redirectTo = undefined;
    destination.closeAllConnections(); await new Promise(r => destination.close(r));
  }
});

test('invalid connection credentials are rejected privately without replacing working settings', async () => {
  const dir = join(home,'validation');
  assert.equal((await configure(dir)).code,0);
  for (const values of [
    {'Authorization':'Bearer management-secret'},
    {'CF-Access-Client-Secret':'invalid-secret\r\nInjected: value'},
    {'CF-Access-Client-Secret':'invalid-secret\u0000'},
  ]) {
    const invalid = await cli(['configure','--private-dir',dir],{headers:values});
    assert.equal(invalid.code,1);
    assert.ok(!invalid.stderr.includes('management-secret'));
    assert.ok(!invalid.stderr.includes('invalid-secret'));
    assert.equal((await cli(['check','--private-dir',dir])).code,0);
  }
});

test('overlapping registration and configuration cannot overwrite an identity or its settings', async () => {
  for (const preconfigured of [true,false]) {
    const dir = join(home,preconfigured ? 'configured-overlap' : 'direct-overlap');
    if (preconfigured) assert.equal((await configure(dir)).code,0);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    let registrations = 0;
    registrationHandler = async (_req,res) => {
      const id = ++registrations;
      if (id === 1) {started.resolve(); await release.promise;}
      res.end(JSON.stringify({outpostId:`overlap-${id}`,credential:`overlap-credential-${id}`,versions}));
    };
    const args = ['register','--private-dir',dir,'--company','fixture-company','--name','Overlap worker'];
    if (!preconfigured) args.push('--instance',origin,'--workspace-root',workspace,'--scratch-root',scratch);
    const input = {operatorAuthorization:'Bearer operator-secret',...(preconfigured ? {} : {headers})};
    const first = cli(args,input);
    try {
      await Promise.race([started.promise,first.then(() => assert.fail('registration exited before reaching the fixture'))]);
      const requestsBefore = requests.length;
      for (const result of [await cli(args,input),await configure(dir,{})]) {
        assert.equal(result.code,1,'overlapping management command must fail');
        assert.match(result.stderr,/connection management already in progress.*retry/);
      }
      assert.equal(requests.length,requestsBefore,'rejected commands must not create remote identities');
      assert.equal(registrations,1);
    } finally {
      release.resolve();
      await first;
      registrationHandler = undefined;
    }
    const registered = await first;
    assert.equal(registered.code,0,registered.stderr);
    const saved = JSON.parse(readFileSync(join(dir,'connection.json'),'utf8'));
    assert.equal(saved.outpostId,JSON.parse(registered.stdout).outpostId);
    assert.deepEqual(saved.headers,headers);
    assert.equal((await cli(args,input)).code,1,'registered identity must refuse re-registration');
    assert.equal((await configure(dir,{})).code,0,'management lock must release after registration');
    const updated = JSON.parse(readFileSync(join(dir,'connection.json'),'utf8'));
    assert.equal(updated.credential,saved.credential);
    assert.equal(updated.outpostId,saved.outpostId);
    assert.equal(updated.headers,undefined);
  }
});
