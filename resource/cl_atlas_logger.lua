-- atAdmin Advanced Logger (client)
local function cv(n) return GetConvarInt('atadmin_log_' .. n, 1) == 1 end
local function send(k, d) TriggerServerEvent('atadmin:logger:client', k, d) end

CreateThread(function()
    local curVeh, curSeat = 0, nil
    while true do
        Wait(600)
        local ped = PlayerPedId()
        local veh = GetVehiclePedIsIn(ped, false)
        if veh ~= curVeh then
            if curVeh ~= 0 and DoesEntityExist(curVeh) and cv('vehicle') then
                send('vehLeave', { model = GetDisplayNameFromVehicleModel(GetEntityModel(curVeh)), plate = GetVehicleNumberPlateText(curVeh), engine = GetIsVehicleEngineRunning(curVeh) })
            end
            if veh ~= 0 and cv('vehicle') then
                curSeat = nil
                for s = -1, 6 do if GetPedInVehicleSeat(veh, s) == ped then curSeat = s break end end
                send('vehEnter', { model = GetDisplayNameFromVehicleModel(GetEntityModel(veh)), plate = GetVehicleNumberPlateText(veh), seat = curSeat })
            end
            curVeh = veh
        elseif veh ~= 0 then
            local seat
            for s = -1, 6 do if GetPedInVehicleSeat(veh, s) == ped then seat = s break end end
            if seat and curSeat ~= nil and seat ~= curSeat and cv('vehicle') then
                send('vehSeat', { model = GetDisplayNameFromVehicleModel(GetEntityModel(veh)), seat = seat })
            end
            if seat then curSeat = seat end
        end
    end
end)

-- kills / damage dealt to other players
AddEventHandler('gameEventTriggered', function(name, args)
    if name ~= 'CEventNetworkEntityDamage' then return end
    local victim, attacker, weapon, fatal = args[1], args[2], args[7], args[6] == 1
    if attacker ~= PlayerPedId() or not IsPedAPlayer(victim) or victim == attacker then return end
    local vid = NetworkGetPlayerIndexFromPed(victim)
    local sid = vid and vid ~= -1 and GetPlayerServerId(vid) or nil
    local wname = ('hash %s'):format(weapon)
    if fatal then if cv('kill') then send('kill', { victim = sid, weapon = wname }) end
    elseif cv('damage') then send('damage', { victim = sid, weapon = wname }) end
end)

-- shooting summary (batched, one log per burst)
CreateThread(function()
    local shots, wp = 0, nil
    while true do
        Wait(0)
        local ped = PlayerPedId()
        if IsPedShooting(ped) then shots = shots + 1; wp = GetSelectedPedWeapon(ped)
        elseif shots > 0 then
            Wait(1500)
            if not IsPedShooting(ped) and cv('shooting') then send('shooting', { weapon = 'hash ' .. tostring(wp), count = shots }); shots = 0 end
        end
    end
end)

-- weapon switches
CreateThread(function()
    local last = 0
    while true do
        Wait(1000)
        local w = GetSelectedPedWeapon(PlayerPedId())
        if w ~= last then
            last = w
            if w ~= GetHashKey('WEAPON_UNARMED') and cv('weapon') then send('weaponSwitch', { weapon = 'hash ' .. tostring(w) }) end
        end
    end
end)
