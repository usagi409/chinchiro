const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = {};

function judgeChinchiro(dice) {
    const sorted = [...dice].sort((a, b) => a - b);
    
    if (sorted[0] === 1 && sorted[1] === 1 && sorted[2] === 1) {
        return { rank: 5, name: 'ピンゾロ (5倍配当)', score: 5 };
    }
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `ゾロ目 (${sorted[0]}-ゾロ)`, score: 4 };
    }
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 3, name: 'シゴロ (2倍勝ち)', score: 3 };
    }
    if (sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3) {
        return { rank: -1, name: 'ヒフミ (2倍負け)', score: -1 };
    }
    
    const unique = [...new Set(sorted)];
    if (unique.length === 2) {
        const eye = sorted.find(x => sorted.filter(v => v === x).length === 1);
        return { rank: 1, name: `${eye}の目`, score: eye };
    }
    
    return { rank: 0, name: '目なし (やり直し)', score: 0 };
}

io.on('connection', (socket) => {
    console.log(`新しい賭博者が接続: ${socket.id}`);

    socket.on('create-room', ({ userName, wallet }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            host: socket.id,
            gameMaster: socket.id, // 初期値は作成者（ホスト）を親に
            currentTurnIndex: 0,
            players: [{
                id: socket.id,
                name: userName,
                chips: wallet || 1000,
                role: 'host'
            }],
            status: 'waiting'
        };

        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, gameMaster: rooms[roomId].gameMaster });
        console.log(`部屋作成: ${roomId} by ${userName}`);
    });

    socket.on('join-room', ({ roomId, userName, wallet }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error-msg', '指定された部屋は見つかりません');
            return;
        }
        if (room.status === 'playing') {
            socket.emit('error-msg', 'すでにゲームが開始されているため参加できません');
            return;
        }
        if (room.players.length >= 10) {
            socket.emit('error-msg', '部屋が満員です（最大10人）');
            return;
        }

        room.players.push({
            id: socket.id,
            name: userName,
            chips: wallet || 1000,
            role: 'guest'
        });

        socket.join(roomId);
        io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
        socket.emit('joined', { roomId, players: room.players, gameMaster: room.gameMaster });
        console.log(`${userName} が部屋 ${roomId} に参加`);
    });

    // ゲームの親（gameMaster）を設定する（ホストのみ操作可能）
    socket.on('set-game-master', ({ roomId, targetSocketId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        
        const target = room.players.find(p => p.id === targetSocketId);
        if (target) {
            room.gameMaster = targetSocketId;
            io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
        }
    });

    // ホストによるゲーム開始
    socket.on('start-game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;

        if (room.players.length < 2) {
            socket.emit('error-msg', 'ゲームを開始するには2人以上のプレイヤーが必要です！');
            return;
        }

        room.status = 'playing';
        const gmIndex = room.players.findIndex(p => p.id === room.gameMaster);
        room.currentTurnIndex = gmIndex !== -1 ? gmIndex : 0;

        io.to(roomId).emit('game-started', {
            currentTurnId: room.players[room.currentTurnIndex].id,
            gameMasterId: room.gameMaster
        });
        console.log(`部屋 ${roomId} でゲーム開始`);
    });

    socket.on('roll-dice', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('error-msg', 'あなたのターンではありません！');
            return;
        }

        if (bet <= 0 || bet > currentPlayer.chips) {
            socket.emit('error-msg', '所持金を超えるベットはできません');
            return;
        }

        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);

        // 次のプレイヤーにターンを回す
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextPlayerId = room.players[room.currentTurnIndex].id;

        io.to(roomId).emit('dice-result', {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name,
            dice,
            result,
            nextTurnId: nextPlayerId,
            nextTurnName: room.players[room.currentTurnIndex].name
        });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const wasHost = room.host === socket.id;
            const wasGm = room.gameMaster === socket.id;
            room.players = room.players.filter(p => p.id !== socket.id);
            
            if (room.players.length === 0) {
                delete rooms[roomId];
                console.log(`部屋 ${roomId} は誰もいなくなったため消滅しました`);
            } else {
                if (wasHost && room.players.length > 0) {
                    room.host = room.players[0].id;
                    room.players[0].role = 'host';
                    io.to(roomId).emit('host-changed', { newHostId: room.host });
                }
                if (wasGm && room.players.length > 0) {
                    room.gameMaster = room.players[0].id;
                }
                if (room.currentTurnIndex >= room.players.length) {
                    room.currentTurnIndex = 0;
                }
                io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`闇のチンチロ胴元サーバーがポート ${PORT} で起動しました`);
});
