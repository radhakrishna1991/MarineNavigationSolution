# Deploying to IIS with iisnode

Deploys the platform as the application **MNS** under **Default Web Site**, at
`http://<host>/MNS/`.

**Part 1 is done once per server. Part 2 is what you run for every deploy after
that — five commands.**

One IIS application serves both halves. IIS serves the built dashboard as static
files; iisnode runs the Node backend and receives only the API and the live
stream:

```
  http://host/MNS/                 ->  public\index.html          (IIS, static)
  http://host/MNS/assets/...       ->  public\assets\...          (IIS, static)
  http://host/MNS/alarms           ->  public\index.html          (client route)
  http://host/MNS/api/...          ->  app.js                     (iisnode -> Node)
  ws://host/MNS/ws/live            ->  app.js                     (iisnode -> Node)
```

Both halves sit on one origin and one path, so `CORS_ORIGINS` stays empty and
the WebSocket upgrade travels the same route as everything else. Same-origin
requests are recognised by comparing the browser's `Origin` against the `Host`
the request arrived on, so reaching the dashboard by `localhost`, by machine
name or by IP all work without naming any of them.

The deployed tree:

```
C:\inetpub\wwwroot\MNS\
  web.config              IIS wiring                       from deploy\iis\
  app.js                  iisnode entry point              from deploy\iis\
  package.json            pins how Node interprets app.js
  .env                    settings and secrets             lives only here
  backend\src\            backend source                   copied each deploy
  backend\node_modules\   production dependencies          installed once
  public\                 built dashboard                  copied each deploy
  data\                   exports written at runtime        needs write access
  iisnode\                stdout and stderr from Node       needs write access
```

`backend\` sits one level down deliberately: the configuration loader resolves
the application root three levels up from `src\config`, and that is where it
looks for `.env` and `data\`.

---

# Part 1 — One-time server setup

Run these once. You never repeat them unless you rebuild the server.

## 1.1 Install the prerequisites

| # | Component | Where |
|---|---|---|
| 1 | **IIS** with the **WebSocket Protocol** role service | Server Manager → Add Roles and Features → Web Server (IIS) → Application Development → **WebSocket Protocol** |
| 2 | **Node.js 20+** (LTS x64) | <https://nodejs.org> |
| 3 | **iisnode** (x64) | <https://github.com/Azure/iisnode/releases> — `iisnode-full-v0.2.26-x64.msi` |
| 4 | **URL Rewrite 2.1** | <https://www.iis.net/downloads/microsoft/url-rewrite> |
| 5 | **PostgreSQL 14+** | <https://www.postgresql.org/download/windows/> |

Install **Node before iisnode**, then run `iisreset`.

Check all four landed:

```powershell
Test-Path 'C:\Windows\System32\inetsrv\iiswsock.dll'   # WebSocket role service
Test-Path 'C:\Program Files\iisnode\iisnode.dll'       # iisnode
Test-Path 'C:\Windows\System32\inetsrv\rewrite.dll'    # URL Rewrite
node -v                                                 # Node
```

All four must be `True`. A missing URL Rewrite or WebSocket role service is an
HTTP 500.19 the moment you browse, because `web.config` names a configuration
section that does not exist.

## 1.2 Create the folder structure

```powershell
mkdir C:\inetpub\wwwroot\MNS\backend
mkdir C:\inetpub\wwwroot\MNS\public
mkdir C:\inetpub\wwwroot\MNS\data
mkdir C:\inetpub\wwwroot\MNS\iisnode
```

## 1.3 Copy the static files

From the repository root:

```powershell
cd E:\ISTProjects\MarineNavigationSolution
copy deploy\iis\web.config      C:\inetpub\wwwroot\MNS\
copy deploy\iis\app.js          C:\inetpub\wwwroot\MNS\
copy backend\package.json       C:\inetpub\wwwroot\MNS\backend\
copy .env.example               C:\inetpub\wwwroot\MNS\.env
```

Then write the application-root manifest, which pins how Node interprets
`app.js` rather than letting it depend on what sits above the folder:

```powershell
@'
{
  "name": "amnp-iis",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs"
}
'@ | Set-Content C:\inetpub\wwwroot\MNS\package.json -Encoding utf8
```

## 1.4 Point web.config at Node

`web.config` ships with `C:\Program Files\nodejs\node.exe`. This command reads
the real path and writes it in, so it is correct on any server:

```powershell
$node = (Get-Command node).Source
$cfg  = 'C:\inetpub\wwwroot\MNS\web.config'
(Get-Content $cfg -Raw) -replace 'nodeProcessCommandLine="[^"]*"', "nodeProcessCommandLine=`"&quot;$node&quot;`"" |
    Set-Content $cfg -Encoding utf8
Select-String $cfg -Pattern 'nodeProcessCommandLine'
```

The last line prints what it wrote — check it matches your Node install.

A wrong path here is the most common cause of a blank HTTP 500 with an empty
`iisnode\` folder: Node never starts, so it never logs anything.

> Re-run this whenever you re-copy `web.config` (Part 3.3).

## 1.5 Install the production dependencies

```powershell
cd C:\inetpub\wwwroot\MNS\backend
npm install --omit=dev --no-audit --no-fund
```

Installs 114 packages, about 6 MB. Only repeated when `backend\package.json`
changes (Part 3.1).

## 1.6 Edit .env

```powershell
notepad C:\inetpub\wwwroot\MNS\.env
```

Set these — the platform refuses to start on a placeholder `JWT_SECRET`:

```ini
NODE_ENV=production
APP_BASE_PATH=/MNS          # must match the IIS alias in 1.8
CORS_ORIGINS=               # empty: same-origin only (see the note below)

PGHOST=localhost
PGPORT=5432
PGDATABASE=marinenavigation
PGUSER=postgres
PGPASSWORD=<your password>

JWT_SECRET=<see below>
SEED_ADMIN_PASSWORD=<choose one>
SEED_DEMO_PASSWORD=<choose one>
```

Generate the secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`BACKEND_PORT` and `BACKEND_HOST` are ignored under iisnode — IIS owns the
listening socket and hands Node a named pipe instead.

**On `CORS_ORIGINS`.** Leave it empty. The dashboard and the API share an origin,
and a same-origin request is allowed by comparing `Origin` against `Host` rather
than against a list — so it keeps working however the server is reached. Add
entries only for a browser on a *different* origin (a dashboard hosted
elsewhere). Do not add the server's own address: it is unnecessary, and the list
would then need every name and IP the server answers to.

This file lives only on the server. Nothing in Part 2 overwrites it.

## 1.7 Create and seed the database

```powershell
# Create the database (psql on PATH, or use pgAdmin's query tool)
psql -U postgres -c "CREATE DATABASE marinenavigation;"
```

The schema is applied automatically on every start, so there are no migrations
to run. But the reference data is **not** — seed it now:

```powershell
cd C:\inetpub\wwwroot\MNS
node backend\src\db\seed.js
```

**Do not skip this.** Startup creates the schema and seeds vessels only. The
login accounts, sensor catalogue, scenario definitions and geospatial
environment all come from `seed.js`. Without it the dashboard loads and there is
no account to sign in as.

It ends with `seed complete` and lists the accounts: `admin`, `engineer`,
`operator`, `viewer` — passwords are the `SEED_*` values from 1.6. Re-running is
safe; it updates rows in place.

If this fails, the database is unreachable, and IIS would have failed the same
way with far less to go on.

## 1.8 Create the application pool and application

**Run PowerShell as Administrator** for this step and the next.

```powershell
$appcmd = 'C:\Windows\System32\inetsrv\appcmd.exe'

# No Managed Code (the app is Node; the CLR only adds memory),
# AlwaysRunning (the simulation should be live before anyone browses)
& $appcmd add apppool /name:MNS /managedRuntimeVersion:"" /startMode:AlwaysRunning

# Idle timeout 0   - the default 20 min kills the pool when idle, discarding the
#                    running scenario and every connected display
# Recycling 0      - the default recycles every 29 h, restarting the simulation
& $appcmd set apppool /apppool.name:MNS /processModel.idleTimeout:00:00:00
& $appcmd set apppool /apppool.name:MNS /recycling.periodicRestart.time:00:00:00

# The application itself
& $appcmd add app /site.name:"Default Web Site" /path:/MNS `
    /physicalPath:C:\inetpub\wwwroot\MNS /applicationPool:MNS
```

The alias `/MNS` must match `APP_BASE_PATH` in `.env`, and the `VITE_BASE_PATH`
the dashboard is built with. Changing it means rebuilding the dashboard.

Verify:

```powershell
& $appcmd list apppool /apppool.name:MNS
& $appcmd list app /app.name:"Default Web Site/MNS"
```

## 1.9 Grant permissions

Still elevated. The worker process runs as `IIS AppPool\MNS`: it reads
everything and writes to exactly two folders.

```powershell
# Read and execute over the application - the process cannot rewrite its own code
icacls C:\inetpub\wwwroot\MNS /grant "IIS AppPool\MNS:(OI)(CI)(RX)" /T

# The two folders it genuinely writes to
icacls C:\inetpub\wwwroot\MNS\data    /grant "IIS AppPool\MNS:(OI)(CI)(M)" /T
icacls C:\inetpub\wwwroot\MNS\iisnode /grant "IIS AppPool\MNS:(OI)(CI)(M)" /T
```

**If Node is not under `C:\Program Files`**, the pool identity has no inherent
right to read it:

```powershell
icacls "$(Split-Path (Get-Command node).Source)" /grant "IIS AppPool\MNS:(OI)(CI)(RX)" /T
```

## 1.10 Deploy the code

Now run **Part 2** for the first time.

## 1.11 Harden

Once it is verified working, turn off inline error detail:

```powershell
$cfg = 'C:\inetpub\wwwroot\MNS\web.config'
(Get-Content $cfg -Raw) -replace 'devErrorsEnabled="true"', 'devErrorsEnabled="false"' |
    Set-Content $cfg -Encoding utf8
```

It ships as `true` so a first-deployment failure shows its reason instead of a
bare 500. Stack traces should not be served afterwards. Saving `web.config`
restarts the application on its own.

---

# Part 2 — Every deploy

**This is the whole routine.** Five commands, from the repository root, elevated
(stopping the pool needs it):

```powershell
cd E:\ISTProjects\MarineNavigationSolution

# 1. Build the dashboard with the base path compiled in
$env:VITE_BASE_PATH = '/MNS'; npm run build --workspace frontend; Remove-Item Env:\VITE_BASE_PATH

# 2. Stop the pool - Node holds its own files open, and a copy over a running
#    application fails part-way through
C:\Windows\System32\inetsrv\appcmd.exe stop apppool /apppool.name:MNS

# 3. Copy the two things that change. /MIR mirrors, so renamed content-hashed
#    assets do not accumulate. /XF skips source maps (9.5 MB of an 11 MB build,
#    only ever fetched with devtools open, and .map has no MIME type in IIS).
robocopy frontend\dist C:\inetpub\wwwroot\MNS\public      /MIR /XF *.map
robocopy backend\src   C:\inetpub\wwwroot\MNS\backend\src /MIR

# 4. Start it again
C:\Windows\System32\inetsrv\appcmd.exe start apppool /apppool.name:MNS
```

Then verify:

```powershell
Invoke-RestMethod http://localhost/MNS/api/health
```

Expect `status: ok` and `database: ok`. Robocopy exiting 1 or 3 means it copied
files — only 8 and above are failures.

`.env`, `data\`, `web.config` and `node_modules\` are deliberately untouched:
the first two hold the server's own state, and the other two rarely change.

---

# Part 3 — The occasional extras

Only when the matching thing changed.

### 3.1 Backend dependencies changed

When `backend/package.json` gained or dropped a dependency:

```powershell
cd C:\inetpub\wwwroot\MNS\backend
copy E:\ISTProjects\MarineNavigationSolution\backend\package.json .
npm install --omit=dev --no-audit --no-fund
```

### 3.2 New seed data

When sensors, scenarios or the geospatial environment changed in
`backend/src/config/*.yaml`:

```powershell
cd C:\inetpub\wwwroot\MNS
node backend\src\db\seed.js
```

### 3.3 web.config changed

```powershell
copy E:\ISTProjects\MarineNavigationSolution\deploy\iis\web.config C:\inetpub\wwwroot\MNS\
```

Then **re-run 1.4** (it resets the Node path) and **re-run 1.11** if you had
already hardened.

### 3.4 Full verification

```powershell
Invoke-RestMethod http://localhost/MNS/api/health          # API + database
(Invoke-WebRequest http://localhost/MNS/).StatusCode        # dashboard: 200
(Invoke-WebRequest http://localhost/MNS/alarms).StatusCode  # deep link: 200, not 404
Get-Content C:\inetpub\wwwroot\MNS\iisnode\*.txt -Tail 20   # 'platform ready'
```

Then open `http://localhost/MNS/` and sign in as `admin`. The connection
indicator in the header shows the live stream state; when it settles on
*connected*, the WebSocket upgrade is working end to end.

---

## Deploying to a different server

Everything above assumes the repository is on the machine you deploy from. It
does not have to be the IIS server — swap the local paths in Part 2 for a UNC
path:

```powershell
robocopy frontend\dist \\SERVER\c$\inetpub\wwwroot\MNS\public /MIR /XF *.map
```

If the repository cannot be on the target server at all and you cannot reach it
over the network, build the tree locally and copy the whole
`C:\inetpub\wwwroot\MNS` folder across once; then Parts 1.4 and 1.6 onwards run
on the target as written.

---

## How the pieces fit

### The single Node process

`web.config` sets `nodeProcessCountPerApplication="1"`. This is not a
performance dial — it is a correctness constraint. The scenario engine, the
WebSocket hub and the UDP listener all hold state in the process. A second
process would run a divergent copy of the simulation, serve inconsistent answers
depending on which one took the request, and fight for UDP port 5005.

### WebSockets through iisnode

`<webSocket enabled="false" />` disables IIS's own WebSocket module so iisnode
performs the upgrade itself. Left enabled, the module answers the upgrade first
and `/MNS/ws/live` never reaches Node. The role service still has to be
installed — the setting is a handover, not a removal.

### The virtual path

An IIS application receives requests with its alias still on the path, so Node
sees `/MNS/api/health` where the routes are declared as `/api/health`. Rather
than thread a prefix through every router:

- `APP_BASE_PATH` is stripped once, in `backend/src/app.js`, before routing.
  `req.originalUrl` keeps the full path, so the access log still shows what the
  browser actually asked for. Stripping is a no-op when the prefix is absent,
  which is what keeps development and Docker unaffected.
- The WebSocket hub matches the tail of the upgrade path, so `/MNS/ws/live` and
  `/ws/live` both reach it and the hub needs no configuration of its own.
- On the client, `VITE_BASE_PATH` becomes `import.meta.env.BASE_URL`, which
  drives the router `basename`, the API base URL and the WebSocket URL together.

So `/MNS` is set in three places that must agree: the IIS application alias
(1.8), `APP_BASE_PATH` in `.env` (1.6), and `VITE_BASE_PATH` at build time
(Part 2).

### URL Rewrite

Static assets are told apart from client routes by extension rather than by
probing the disk: a request ending in a known asset extension is served from
`public\`, anything else is a client route that gets `index.html`.

The match is a list of extensions rather than "the last segment contains a dot",
because the looser test would send a client route carrying a dot — a vessel
identifier in a path segment, say — to the static handler and return a 404 where
the dashboard was wanted.

### MIME types

`web.config` deliberately declares none. Which types IIS already knows varies by
version and by what else is installed, and declaring one that is already present
is a 500.19 that takes the whole application down rather than a harmless
duplicate. The build emits only `.js`, `.css` and `.html`, which every IIS knows.

---

## Troubleshooting

**HTTP 500, `iisnode\` folder empty**
iisnode could not start Node at all. Almost always the Node path — re-run 1.4,
and check `IIS AppPool\MNS` can read that directory (1.9).

**HTTP 500.19**
`web.config` cannot be read. Usually URL Rewrite is missing (the `<rewrite>`
section is then undefined) or the WebSocket role service is not installed (the
`<webSocket>` element likewise). The error page names the offending section.

**HTTP 500, `iisnode\` says `the platform cannot start without its database`**
Node started; PostgreSQL did not answer. Check the `PG*` values in `.env` and
that the service is running. Step 1.7 exercises the same path with a clearer
error.

**Sign-in fails with `403 CORS_ORIGIN_NOT_ALLOWED`, `Origin <address> is not allowed`**
A browser sends `Origin` on a same-origin POST, so the sign-in was checked
against `CORS_ORIGINS` and refused. Handled in `backend/src/app.js`: a request
whose `Origin` matches the `Host` it arrived on is treated as same-origin.
Redeploy `backend\src` (Part 2) and restart the pool.

That covers IIS serving the origin itself. It does **not** cover a reverse proxy
in front of IIS that rewrites `Host` — the browser then reports the public
address while Node sees the internal one, and the two cannot match. Check which
you have:

```powershell
Get-ChildItem C:\inetpub\wwwroot\MNS\iisnode\*.txt |
    Select-String -Pattern 'CORS_ORIGIN_NOT_ALLOWED' -Context 0,1
```

If redeploying does not clear it, `Host` is being rewritten. Name the public
origin explicitly and restart the pool:

```ini
CORS_ORIGINS=https://your.public.hostname
```

Scheme and port must match the browser's address bar exactly; no trailing slash.

> On older builds this failure arrived as a bare **500 `INTERNAL_ERROR`** with
> no reason, because the refusal reached the error handler with no status and
> 5xx bodies withhold their detail. It is now a 403 that names the origin.

**Sign-in rejects a correct password**
Step 1.7 was skipped, or ran before `SEED_ADMIN_PASSWORD` was set. Set it and
re-run `node backend\src\db\seed.js`.

**Blank page, 404s for `/assets/...` with no `/MNS` prefix**
The dashboard was built without `VITE_BASE_PATH`. Re-run Part 2 step 1.

**Dashboard loads but every API call 404s**
The IIS alias and `APP_BASE_PATH` disagree. Both must say `MNS`.

**Dashboard loads, live indicator never connects**
The WebSocket upgrade is being intercepted. Confirm `<webSocket enabled="false" />`
is in the deployed `web.config`, that the WebSocket Protocol role service is
installed, and that nothing at site level re-enables it.

**Exports fail with a permissions error**
`IIS AppPool\MNS` needs Modify on `C:\inetpub\wwwroot\MNS\data` (1.9).

**The scenario resets on its own**
Something is recycling the pool. Re-check 1.8: idle timeout and periodic restart
must both be `00:00:00`.

**robocopy "failed"**
Exit codes 0–7 are success (1 = files copied, 3 = copied + extras removed). Only
8 and above are real failures.
