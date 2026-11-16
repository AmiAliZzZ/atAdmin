-- atAdmin Database Status (server)
-- Prints the database connection status at the end of the console:
--   green  = connected,   red = problem (with the reason)
-- Console command:  dbstatus   (re-checks now)
if not TX_SERVER_MODE then return end

local GREEN, RED, YELLOW, RESET = '^2', '^1', '^3', '^7'
local lastState = nil -- true / false / nil (unknown)

-- describe the target from the convar WITHOUT the password
local function describe()
    local cs = GetConvar('mysql_connection_string', '')
    if cs == '' then return 'mysql_connection_string is not set in server.cfg' end
    local host, port, db = cs:match('@([^:/%s]+):?(%d*)/([^?%s"]*)')
    if host then return ('%s:%s / %s'):format(host, (port ~= '' and port or '3306'), db) end
    local h = cs:match('host=([^;]+)')
    local p = cs:match('port=(%d+)')
    local d = cs:match('database=([^;]+)')
    if h or d then return ('%s:%s / %s'):format(h or 'localhost', p or '3306', d or '?') end
    return 'custom connection string'
end

local function printOk()
    print(('%s[Database] Status: CONNECTED  (%s)%s'):format(GREEN, describe(), RESET))
end

local function printFail(reason)
    print(('%s[Database] Status: NOT CONNECTED%s'):format(RED, RESET))
    print(('%s[Database] Error: %s%s'):format(RED, tostring(reason), RESET))
    print(('%s[Database] Target: %s%s'):format(RED, describe(), RESET))
    print(('%s[Database] Check: DB server running on that host/port, user + password in mysql_connection_string, and "ensure oxmysql" before your scripts.%s'):format(YELLOW, RESET))
end

-- one real end-to-end test through oxmysql: cb(ok, errorText)
local function check(cb)
    local state = GetResourceState('oxmysql')
    if state ~= 'started' then
        return cb(false, ('oxmysql resource is not started (state: %s). Add "ensure oxmysql" to server.cfg.'):format(state))
    end
    local done = false
    local ok, err = pcall(function()
        exports.oxmysql:scalar('SELECT 1', {}, function(v)
            if done then return end
            done = true
            if v == 1 or v == '1' then cb(true)
            else cb(false, 'oxmysql could not run a test query (see the oxmysql error above - e.g. ECONNREFUSED / Access denied / Unknown database)') end
        end)
    end)
    if not ok then done = true return cb(false, 'oxmysql export error: ' .. tostring(err)) end
    SetTimeout(8000, function()
        if done then return end
        done = true
        cb(false, 'no response from the database after 8 seconds (timeout)')
    end)
end

-- test with a few retries (oxmysql may still be connecting while the server boots)
local function checkWithRetry(attempts, cb)
    local n = 0
    local function try()
        n = n + 1
        check(function(ok, err)
            if ok or n >= attempts then return cb(ok, err) end
            SetTimeout(3000, try)
        end)
    end
    try()
end

local function report(ok, err)
    lastState = ok
    if ok then printOk() else printFail(err) end
end

CreateThread(function()
    -- wait for oxmysql (max 60s) so we do not report too early
    local waited = 0
    while GetResourceState('oxmysql') ~= 'started' and waited < 60000 do Wait(500) waited = waited + 500 end

    checkWithRetry(4, report)

    -- final summary near the end of the boot output, so it is the last thing you see
    Wait(15000)
    checkWithRetry(1, report)

    -- watchdog: print only when the state changes (connected <-> not connected)
    while true do
        Wait(30000)
        checkWithRetry(1, function(ok, err)
            if ok ~= lastState then report(ok, err) end
        end)
    end
end)

RegisterCommand('dbstatus', function(src)
    if src ~= 0 then return end -- console only
    checkWithRetry(1, report)
end, true)
