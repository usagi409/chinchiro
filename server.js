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
        return { rank: 5, name: 'ピンゾロ (5倍配当)' };
    }
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `ゾロ目 (${sorted[0]}-ゾロ)` };
    }
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 3, name: 'シゴロ (2倍勝ち)' };
    }
    if (sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3) {
        return { rank: -1, name: 'ヒフミ (2倍負け)' };
    }
    
    const unique = [...new Set(sorted)];
    if (unique.length === 2) {
        const eye = sorted.find(x => sorted.filter(v => v === x).length === 1);
        return { rank: 1, name: `${eye}の目`, point: eye };
    }
    
    return { rank: 0, name: '目なし (やり直し)' };
}

io.on('connection', (socket) => {
    console.log(`新しい賭博者が接続: ${socket.id}`);

    socket.on('create-room', ({ userName, wallet }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            host: socket.id,
            players: [{
                id: socket.id,
                name: userName,
                chips: wallet || 1000,
                role: 'host'
            }],
            status: 'waiting'
        };

        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, isHost: true });
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
        io.to(roomId).emit('update-room', { players: room.players });
        socket.emit('joined', { roomId, players: room.players, isHost: false });
        console.log(`${userName} が部屋 ${roomId} に参加`);
    });

    // ホストによるゲーム開始
    socket.on('start-game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;

        room.status = 'playing';
        io.to(roomId).emit('game-started');
        console.log(`部屋 ${roomId} でゲーム開始`);
    });

    // 待機画面（ロビー）に戻る
    socket.on('back-to-waiting', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;

        room.status = 'waiting';
        io.to(roomId).emit('room-reset');
        console.log(`部屋 ${roomId} が待機状態に戻りました`);
    });

    socket.on('roll-dice', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (bet <= 0 || bet > player.chips) {
            socket.emit('error-msg', '所持金を超えるベッドはできません');
            return;
        }

        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);

        io.to(roomId).emit('dice-result', {
            playerName: player.name,
            dice,
            result
        });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const wasHost = room.host === socket.id;
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
                io.to(roomId).emit('update-room', { players: room.players });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`闇のチンチロ胴元サーバーがポート ${PORT} で起動しました`);
});
