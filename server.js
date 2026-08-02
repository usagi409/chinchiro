const express = require('express');
const http = http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // ローカルファイル（file://）からの接続も許可
        methods: ["GET", "POST"]
    }
});

// 部屋ごとの状態を管理するオブジェクト
const rooms = {};

// チンチロの役判定ロジック
function judgeChinchiro(dice) {
    const sorted = [...dice].sort((a, b) => a - b);
    
    // ピンゾロ (1-1-1)
    if (sorted[0] === 1 && sorted[1] === 1 && sorted[2] === 1) {
        return { rank: 5, name: 'ピンゾロ (5倍配当)' };
    }
    // ゾロ目 (2-2-2 ~ 6-6-6)
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `ゾロ目 (${sorted[0]}-ゾロ)` };
    }
    // シゴロ (4-5-6)
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 3, name: 'シゴロ (2倍勝ち)' };
    }
    // ヒフミ (1-2-3)
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

    // 部屋を作る
    socket.on('create-room', ({ userName, wallet }) => {
        const roomId = Math.random().toString(36.substring(2, 7)).toUpperCase();
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
        socket.emit('room-created', { roomId, players: rooms[roomId].players });
        console.log(`部屋作成: ${roomId} by ${userName}`);
    });

    // 部屋に参加する
    socket.on('join-room', ({ roomId, userName, wallet }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error-msg', '指定された部屋は見つかりません');
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
        socket.emit('joined', { roomId });
        console.log(`${userName} が部屋 ${roomId} に参加`);
    });

    // サイコロを振る
    socket.on('roll-dice', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (bet <= 0 || bet > player.chips) {
            socket.emit('error-msg', '所持金を超えるベッドはできません');
            return;
        }

        // 3つのサイコロを投擲
        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);

        // 結果を全員に通知
        io.to(roomId).emit('dice-result', {
            playerName: player.name,
            dice,
            result
        });
    });

    // 切断時の処理
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            
            if (room.players.length === 0) {
                delete rooms[roomId];
                console.log(`部屋 ${roomId} は誰もいなくなったため消滅しました`);
            } else {
                io.to(roomId).emit('update-room', { players: room.players });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`闇のチンチロ胴元サーバーがポート ${PORT} で起動しました`);
});
