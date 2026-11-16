-- atAdmin Advanced Logger (server)
-- Every feature can be toggled with a convar in server.cfg, e.g.:  set atadmin_log_vehicle 0
if not TX_SERVER_MODE then return end

local sub = string.sub
local function cv(name) return GetConvarInt('atadmin_log_' .. name, 1) == 1 end
local function clean(v, n) local t = tostring(v or 'unknown'):gsub('[%c]', ' ') return sub(t, 1, n or 100) end
local function pname(src)
    if type(src) == 'number' and GetPlayerName(src) then return '[#' .. src .. '] ' .. clean(GetPlayerName(src), 60) end
    return '[#' .. tostring(src) .. ']'
end

-- same buffer contract as sv_logger.lua: PrintStructuredTrace through our own buffer
local buf = {}
local function alog(src, typ, msg, extra)
    buf[#buf + 1] = { src = src, type = typ, data = { message = msg, extra = extra } }
end
CreateThread(function()
    while true do
        Wait(1000)
        if #buf > 0 then
            local ts = os.time() * 1000
            for i = 1, #buf do buf[i].ts = ts + math.min(i - 1, 999) end
            PrintStructuredTrace(json.encode({ type = 'txAdminLogData', logs = buf }))
            buf = {}
        end
    end
end)

-- Client reported events (vehicle / kill / damage) -----------------------------------
local lastEvt, seatNames = {}, { [-1] = 'driver', [0] = 'front passenger', [1] = 'rear left', [2] = 'rear right' }
RegisterNetEvent('atadmin:logger:client', function(kind, d)
    local src = source
    if type(kind) ~= 'string' or type(d) ~= 'table' then return end
    local now = GetGameTimer()
    if lastEvt[src] and now - lastEvt[src] < 150 then return end -- anti flood
    lastEvt[src] = now

    if kind == 'vehEnter' and cv('vehicle') then
        alog(src, 'at_Vehicle', ('entered vehicle %s [%s] as %s'):format(clean(d.model, 40), clean(d.plate, 12), seatNames[tonumber(d.seat) or 9] or ('seat ' .. clean(d.seat, 3))))
    elseif kind == 'vehLeave' and cv('vehicle') then
        alog(src, 'at_Vehicle', ('left vehicle %s [%s]%s'):format(clean(d.model, 40), clean(d.plate, 12), d.engine == false and ' (engine off)' or ''))
    elseif kind == 'vehSeat' and cv('vehicle') then
        alog(src, 'at_Vehicle', ('switched seat in %s to %s'):format(clean(d.model, 40), seatNames[tonumber(d.seat) or 9] or 'unknown'))
    elseif kind == 'kill' and cv('kill') then
        local v = tonumber(d.victim)
        alog(src, 'at_Kill', ('killed %s with %s'):format(v and pname(v) or 'a player', clean(d.weapon, 40)))
    elseif kind == 'damage' and cv('damage') then
        local v = tonumber(d.victim)
        alog(src, 'at_Damage', ('damaged %s with %s'):format(v and pname(v) or 'a player', clean(d.weapon, 40)))
    elseif kind == 'shooting' and cv('shooting') then
        alog(src, 'at_Shooting', ('fired %s (%s shots)'):format(clean(d.weapon, 40), clean(d.count, 5)))
    elseif kind == 'weaponSwitch' and cv('weapon') then
        alog(src, 'at_Weapon', ('equipped weapon %s'):format(clean(d.weapon, 40)))
    end
end)

AddEventHandler('playerDropped', function() lastEvt[source] = nil end)

-- Commands typed in chat -------------------------------------------------------------
AddEventHandler('chatMessage', function(src, author, text)
    if type(text) == 'string' and sub(text, 1, 1) == '/' and cv('chatcmd') and tonumber(src) and src > 0 then
        alog(src, 'at_ChatCommand', 'used chat command: ' .. clean(text, 200))
    end
end)
AddEventHandler('txsv:logger:addChatMessage', function(src, author, text)
    if type(text) == 'string' and sub(text, 1, 1) == '/' and cv('chatcmd') and tonumber(src) and src > 0 then
        alog(src, 'at_ChatCommand', 'used chat command: ' .. clean(text, 200))
    end
end)
AddEventHandler('rconCommand', function(cmd, args)
    if cv('chatcmd') and cmd ~= 'txaEvent' and cmd ~= 'txaLogger' then
        alog('tx', 'at_ChatCommand', ('console command: %s %s'):format(clean(cmd, 40), clean(table.concat(args or {}, ' '), 160)))
    end
end)

-- OneSync events ---------------------------------------------------------------------
AddEventHandler('giveWeaponEvent', function(sender, data)
    if cv('weapon') then alog(tonumber(sender), 'at_Weapon', 'was given a weapon (hash ' .. clean(data and data.weaponType, 20) .. ')') end
end)
AddEventHandler('removeWeaponEvent', function(sender, data)
    if cv('weapon') then alog(tonumber(sender), 'at_Weapon', 'had a weapon removed (hash ' .. clean(data and data.weaponType, 20) .. ')') end
end)
AddEventHandler('removeAllWeaponsEvent', function(sender)
    if cv('weapon') then alog(tonumber(sender), 'at_Weapon', 'removed all weapons') end
end)
AddEventHandler('startProjectileEvent', function(sender, data)
    if cv('shooting') then alog(tonumber(sender), 'at_Shooting', 'launched projectile (weapon hash ' .. clean(data and data.weaponHash, 20) .. ')') end
end)
AddEventHandler('fireEvent', function(sender, data)
    if cv('fire') then alog(tonumber(sender), 'at_Fire', 'started a fire') end
end)
AddEventHandler('clearPedTasksEvent', function(sender, data)
    if cv('weapon') then alog(tonumber(sender), 'at_Weapon', 'cleared ped tasks (possible abuse)') end
end)
AddEventHandler('entityCreated', function(ent)
    if not cv('entity') or not DoesEntityExist(ent) then return end
    if GetEntityType(ent) ~= 2 then return end
    local owner = NetworkGetEntityOwner(ent)
    if owner and owner > 0 then
        alog(owner, 'at_Entity', ('spawned vehicle (model hash %s)'):format(GetEntityModel(ent)))
    end
end)

-- Resources --------------------------------------------------------------------------
AddEventHandler('onResourceStart', function(res) if cv('resource') then alog('tx', 'at_Resource', 'resource started: ' .. clean(res, 60)) end end)
AddEventHandler('onResourceStop', function(res) if cv('resource') then alog('tx', 'at_Resource', 'resource stopped: ' .. clean(res, 60)) end end)
