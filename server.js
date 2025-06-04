const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Создаем приложение Express
const app = express();
app.use(cors());
app.use(express.json());

// Создаем HTTP сервер
const server = http.createServer(app);

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ server });

// Хранилище данных
const users = new Map(); // nickname -> user data
const rooms = new Map(); // roomId -> room data
const connections = new Map(); // ws -> user nickname
const bannedUsers = new Map(); // nickname -> {until, reason}

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
    console.log('Новое соединение установлено');

    // Обработка сообщений
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
            sendError(ws, 'Неверный формат сообщения');
        }
    });

    // Обработка отключений
    ws.on('close', () => {
        const nickname = connections.get(ws);
        if (nickname) {
            console.log(`Пользователь ${nickname} отключился`);
            connections.delete(ws);
            
            // Удаляем пользователя из комнат
            for (const [roomId, room] of rooms.entries()) {
                const playerIndex = room.players.findIndex(p => p.nickname === nickname);
                if (playerIndex !== -1) {
                    room.players.splice(playerIndex, 1);
                    
                    // Если комната пуста, удаляем её
                    if (room.players.length === 0) {
                        rooms.delete(roomId);
                    } else {
                        // Уведомляем остальных игроков
                        broadcastToRoom(roomId, {
                            type: 'player_left',
                            player: { nickname },
                            room
                        });
                    }
                    
                    break;
                }
            }
            
            // Обновляем список комнат для всех
            broadcastRoomsList();
        }
    });
});

// Обработка сообщений
function handleMessage(ws, data) {
    switch (data.type) {
        case 'user_connected':
            handleUserConnected(ws, data.user);
            break;
        case 'ping':
            send(ws, { type: 'pong' });
            break;
        case 'get_rooms':
            sendRoomsList(ws);
            break;
        case 'create_room':
            handleCreateRoom(ws, data);
            break;
        case 'join_room':
            handleJoinRoom(ws, data);
            break;
        case 'leave_room':
            handleLeaveRoom(ws, data);
            break;
        case 'chat_message':
            handleChatMessage(ws, data);
            break;
        case 'admin_force_start':
            handleAdminForceStart(ws, data);
            break;
        case 'admin_add_bot':
            handleAdminAddBot(ws, data);
            break;
        case 'admin_end_game':
            handleAdminEndGame(ws, data);
            break;
        case 'admin_kick_player':
            handleAdminKickPlayer(ws, data);
            break;
        case 'admin_ban_player':
            handleAdminBanPlayer(ws, data);
            break;
        default:
            sendError(ws, 'Неизвестный тип сообщения');
    }
}

// Обработчики сообщений
function handleUserConnected(ws, user) {
    const nickname = user.nickname;
    
    // Проверяем бан
    const banInfo = bannedUsers.get(nickname);
    if (banInfo) {
        const now = Date.now();
        if (banInfo.until === 0 || now < banInfo.until) {
            sendError(ws, `Вы забанены: ${banInfo.reason}${banInfo.until ? ` (до ${new Date(banInfo.until).toLocaleString()})` : ' (навсегда)'}`);
            return;
        } else {
            bannedUsers.delete(nickname);
        }
    }
    
    users.set(nickname, user);
    connections.set(ws, nickname);
    
    console.log(`Пользователь ${nickname} подключился`);
    
    // Отправляем список комнат
    sendRoomsList(ws);
}

function handleCreateRoom(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname) {
        sendError(ws, 'Вы не авторизованы');
        return;
    }
    
    const roomId = uuidv4();
    const room = {
        id: roomId,
        name: data.name,
        creator: users.get(nickname),
        players: [users.get(nickname)],
        minPlayers: data.minPlayers,
        maxPlayers: data.maxPlayers,
        roles: data.roles,
        status: 'waiting',
        createdAt: new Date().toISOString()
    };
    
    rooms.set(roomId, room);
    
    // Отправляем создателю информацию о комнате
    send(ws, {
        type: 'room_created',
        room
    });
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`Комната "${room.name}" создана пользователем ${nickname}`);
}

function handleJoinRoom(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname) {
        sendError(ws, 'Вы не авторизованы');
        return;
    }
    
    const room = rooms.get(data.roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    if (room.status !== 'waiting') {
        sendError(ws, 'Игра уже началась');
        return;
    }
    
    if (room.players.length >= room.maxPlayers) {
        sendError(ws, 'Комната заполнена');
        return;
    }
    
    // Проверяем, не находится ли игрок уже в комнате
    if (room.players.find(p => p.nickname === nickname)) {
        sendError(ws, 'Вы уже в этой комнате');
        return;
    }
    
    // Добавляем игрока в комнату
    const user = users.get(nickname);
    room.players.push(user);
    
    // Отправляем игроку информацию о комнате
    send(ws, {
        type: 'room_joined',
        room
    });
    
    // Уведомляем всех игроков в комнате о новом игроке
    broadcastToRoom(room.id, {
        type: 'player_joined',
        player: user,
        room
    });
    
    // Проверяем, нужно ли начинать игру
    checkGameStart(room);
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`${nickname} присоединился к комнате "${room.name}"`);
}

function handleLeaveRoom(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname) {
        sendError(ws, 'Вы не авторизованы');
        return;
    }
    
    const room = rooms.get(data.roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    // Удаляем игрока из комнаты
    const playerIndex = room.players.findIndex(p => p.nickname === nickname);
    if (playerIndex === -1) {
        sendError(ws, 'Вы не находитесь в этой комнате');
        return;
    }
    
    const player = room.players[playerIndex];
    room.players.splice(playerIndex, 1);
    
    // Если комната пуста, удаляем её
    if (room.players.length === 0) {
        rooms.delete(room.id);
    } else {
        // Уведомляем остальных игроков
        broadcastToRoom(room.id, {
            type: 'player_left',
            player,
            room
        });
    }
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`${nickname} покинул комнату "${room.name}"`);
}

function handleChatMessage(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname) {
        sendError(ws, 'Вы не авторизованы');
        return;
    }
    
    const room = rooms.get(data.roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    // Проверяем, находится ли игрок в комнате
    if (!room.players.find(p => p.nickname === nickname)) {
        sendError(ws, 'Вы не находитесь в этой комнате');
        return;
    }
    
    // Отправляем сообщение всем игрокам в комнате
    broadcastToRoom(data.roomId, {
        type: 'chat_message',
        sender: nickname,
        message: data.message,
        timestamp: new Date().toISOString()
    });
}

// Админ функции
function handleAdminForceStart(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname || nickname !== 'Anubis') {
        sendError(ws, 'У вас нет прав администратора');
        return;
    }
    
    // Находим комнату, в которой находится админ
    let adminRoom = null;
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.find(p => p.nickname === nickname)) {
            adminRoom = room;
            break;
        }
    }
    
    if (!adminRoom) {
        sendError(ws, 'Вы не находитесь ни в одной комнате');
        return;
    }
    
    // Запускаем игру
    startGame(adminRoom);
    
    broadcastToRoom(adminRoom.id, {
        type: 'game_force_started',
        admin: nickname
    });
    
    console.log(`Администратор ${nickname} принудительно запустил игру в комнате "${adminRoom.name}"`);
}

function handleAdminAddBot(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname || nickname !== 'Anubis') {
        sendError(ws, 'У вас нет прав администратора');
        return;
    }
    
    // Находим комнату, в которой находится админ
    let adminRoom = null;
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.find(p => p.nickname === nickname)) {
            adminRoom = room;
            break;
        }
    }
    
    if (!adminRoom) {
        sendError(ws, 'Вы не находитесь ни в одной комнате');
        return;
    }
    
    // Проверяем, есть ли место для бота
    if (adminRoom.players.length >= adminRoom.maxPlayers) {
        sendError(ws, 'Комната заполнена');
        return;
    }
    
    // Создаем бота
    const botName = data.botName || `Bot_${Math.floor(Math.random() * 1000)}`;
    const bot = {
        nickname: botName,
        isBot: true,
        avatar: '🤖'
    };
    
    // Добавляем бота в комнату
    adminRoom.players.push(bot);
    
    // Уведомляем всех игроков в комнате о новом боте
    broadcastToRoom(adminRoom.id, {
        type: 'bot_added',
        bot,
        room: adminRoom
    });
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`Администратор ${nickname} добавил бота ${botName} в комнату "${adminRoom.name}"`);
}

function handleAdminEndGame(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname || nickname !== 'Anubis') {
        sendError(ws, 'У вас нет прав администратора');
        return;
    }
    
    // Находим комнату, в которой находится админ
    let adminRoom = null;
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.find(p => p.nickname === nickname)) {
            adminRoom = room;
            break;
        }
    }
    
    if (!adminRoom) {
        sendError(ws, 'Вы не находитесь ни в одной комнате');
        return;
    }
    
    // Завершаем игру
    adminRoom.status = 'waiting';
    
    // Уведомляем всех игроков в комнате
    broadcastToRoom(adminRoom.id, {
        type: 'game_ended',
        admin: nickname
    });
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`Администратор ${nickname} завершил игру в комнате "${adminRoom.name}"`);
}

function handleAdminKickPlayer(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname || nickname !== 'Anubis') {
        sendError(ws, 'У вас нет прав администратора');
        return;
    }
    
    const playerToKick = data.player;
    if (!playerToKick) {
        sendError(ws, 'Не указан игрок для кика');
        return;
    }
    
    // Находим комнату, в которой находится игрок
    let playerRoom = null;
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.find(p => p.nickname === playerToKick)) {
            playerRoom = room;
            break;
        }
    }
    
    if (!playerRoom) {
        sendError(ws, 'Игрок не находится ни в одной комнате');
        return;
    }
    
    // Удаляем игрока из комнаты
    const playerIndex = playerRoom.players.findIndex(p => p.nickname === playerToKick);
    if (playerIndex !== -1) {
        playerRoom.players.splice(playerIndex, 1);
    }
    
    // Уведомляем всех игроков в комнате
    broadcastToRoom(playerRoom.id, {
        type: 'player_kicked',
        player: playerToKick,
        admin: nickname,
        reason: data.reason || 'Нарушение правил'
    });
    
    // Отправляем сообщение кикнутому игроку
    for (const [clientWs, clientNickname] of connections.entries()) {
        if (clientNickname === playerToKick) {
            send(clientWs, {
                type: 'player_kicked',
                player: playerToKick,
                admin: nickname,
                reason: data.reason || 'Нарушение правил'
            });
            break;
        }
    }
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`Администратор ${nickname} кикнул игрока ${playerToKick} из комнаты "${playerRoom.name}"`);
}

function handleAdminBanPlayer(ws, data) {
    const nickname = connections.get(ws);
    if (!nickname || nickname !== 'Anubis') {
        sendError(ws, 'У вас нет прав администратора');
        return;
    }
    
    const playerToBan = data.player;
    if (!playerToBan) {
        sendError(ws, 'Не указан игрок для бана');
        return;
    }
    
    // Находим комнату, в которой находится игрок
    let playerRoom = null;
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.find(p => p.nickname === playerToBan)) {
            playerRoom = room;
            break;
        }
    }
    
    // Удаляем игрока из комнаты, если он в ней находится
    if (playerRoom) {
        const playerIndex = playerRoom.players.findIndex(p => p.nickname === playerToBan);
        if (playerIndex !== -1) {
            playerRoom.players.splice(playerIndex, 1);
        }
    }
    
    // Баним игрока
    const duration = parseInt(data.duration) || 0;
    const until = duration > 0 ? Date.now() + duration * 60 * 60 * 1000 : 0;
    
    bannedUsers.set(playerToBan, {
        until,
        reason: data.reason || 'Нарушение правил'
    });
    
    // Уведомляем всех игроков
    broadcast({
        type: 'player_banned',
        player: playerToBan,
        admin: nickname,
        reason: data.reason || 'Нарушение правил',
        duration
    });
    
    // Отключаем забаненного игрока
    for (const [clientWs, clientNickname] of connections.entries()) {
        if (clientNickname === playerToBan) {
            send(clientWs, {
                type: 'player_banned',
                player: playerToBan,
                admin: nickname,
                reason: data.reason || 'Нарушение правил',
                duration
            });
            clientWs.close();
            break;
        }
    }
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`Администратор ${nickname} забанил игрока ${playerToBan} на ${duration > 0 ? duration + ' часов' : 'навсегда'}`);
}

// Вспомогательные функции
function checkGameStart(room) {
    if (room.status !== 'waiting') return;
    
    if (room.players.length >= room.minPlayers) {
        // Автоматически начинаем игру, когда достигнуто минимальное количество игроков
        startGame(room);
    }
}

function startGame(room) {
    room.status = 'playing';
    
    // Распределяем роли
    const roles = assignRoles(room.players, room.roles);
    
    // Уведомляем игроков о начале игры
    broadcastToRoom(room.id, {
        type: 'game_started',
        room
    });
    
    // Отправляем каждому игроку его роль
    for (const player of room.players) {
        const role = roles.get(player.nickname);
        if (role) {
            for (const [clientWs, clientNickname] of connections.entries()) {
                if (clientNickname === player.nickname) {
                    send(clientWs, {
                        type: 'role_assigned',
                        role
                    });
                    break;
                }
            }
        }
    }
    
    // Обновляем список комнат для всех
    broadcastRoomsList();
    
    console.log(`Игра началась в комнате "${room.name}"`);
}

function assignRoles(players, availableRoles) {
    const roles = new Map(); // nickname -> role
    const playerCount = players.length;
    
    // Определяем количество каждой роли
    let mafiaCount = Math.max(1, Math.floor(playerCount / 4));
    let sheriffCount = 1;
    let doctorCount = availableRoles.includes('doctor') ? 1 : 0;
    let maniacCount = availableRoles.includes('maniac') ? 1 : 0;
    let loverCount = availableRoles.includes('lover') ? 2 : 0;
    
    // Убеждаемся, что у нас достаточно игроков для всех ролей
    const specialRolesCount = mafiaCount + sheriffCount + doctorCount + maniacCount + loverCount;
    if (specialRolesCount > playerCount) {
        // Корректируем количество ролей
        loverCount = 0;
        if (specialRolesCount - 2 > playerCount) {
            maniacCount = 0;
            if (specialRolesCount - 3 > playerCount) {
                doctorCount = 0;
                if (specialRolesCount - 4 > playerCount) {
                    mafiaCount = 1;
                }
            }
        }
    }
    
    // Создаем массив ролей
    const roleArray = [];
    for (let i = 0; i < mafiaCount; i++) roleArray.push('mafia');
    for (let i = 0; i < sheriffCount; i++) roleArray.push('sheriff');
    for (let i = 0; i < doctorCount; i++) roleArray.push('doctor');
    for (let i = 0; i < maniacCount; i++) roleArray.push('maniac');
    for (let i = 0; i < loverCount; i++) roleArray.push('lover');
    
    // Добавляем мирных жителей
    const civilianCount = playerCount - roleArray.length;
    for (let i = 0; i < civilianCount; i++) roleArray.push('civilian');
    
    // Перемешиваем роли
    for (let i = roleArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roleArray[i], roleArray[j]] = [roleArray[j], roleArray[i]];
    }
    
    // Назначаем роли игрокам
    players.forEach((player, index) => {
        roles.set(player.nickname, roleArray[index]);
    });
    
    return roles;
}

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function sendError(ws, message) {
    send(ws, {
        type: 'error',
        message
    });
}

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastToRoom(roomId, data) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    for (const player of room.players) {
        for (const [clientWs, clientNickname] of connections.entries()) {
            if (clientNickname === player.nickname) {
                send(clientWs, data);
                break;
            }
        }
    }
}

function sendRoomsList(ws) {
    const roomsList = Array.from(rooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        creator: room.creator,
        players: room.players,
        minPlayers: room.minPlayers,
        maxPlayers: room.maxPlayers,
        roles: room.roles,
        status: room.status
    }));
    
    send(ws, {
        type: 'rooms_list',
        rooms: roomsList
    });
}

function broadcastRoomsList() {
    const roomsList = Array.from(rooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        creator: room.creator,
        players: room.players,
        minPlayers: room.minPlayers,
        maxPlayers: room.maxPlayers,
        roles: room.roles,
        status: room.status
    }));
    
    broadcast({
        type: 'rooms_list',
        rooms: roomsList
    });
}

// API маршруты
app.get('/', (req, res) => {
    res.json({
        name: 'Mafia Game Server',
        status: 'running',
        connections: connections.size,
        rooms: rooms.size
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.post('/api/check-nickname', (req, res) => {
    const { nickname } = req.body;
    const isUnique = !users.has(nickname);
    res.json({ isUnique });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});