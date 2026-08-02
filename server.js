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

// チンチロの役判定ロジック
function judgeChinchiro(dice) {
    const sorted = [...dice].sort((a, b) => a - b);
    
    // ピンゾロ (1-1-1)
    if (sorted[0] === 1 && sorted[1] === 1 && sorted[2] === 1) {
        return { rank: 5, name: 'ピンゾロ (5倍)', multiplier: 5, score: 100 };
    }
    // ゾロ目 (2-2-2 ~ 6-6-6)
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `${sorted[0]}のゾロ目 (3倍)`, multiplier: 3, score: 50 + sorted[0] };
    }
    // シゴロ (4-5-6)
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 3, name: 'シゴロ (2倍)', multiplier: 2, score: 40 };
    }
    // ヒフミ (1-2-3)
    if (sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3) {
        return { rank: -1, name: 'ヒフミ (2倍負け)', multiplier: 2, score: -10 };
    }
    
    const unique = [...new Set(sorted)];
    if (unique.length === 2) {
        const eye = sorted.find(x => sorted.filter(v => v === x).length === 1);
        return { rank: 1, name: `${eye}の目 (1倍)`, multiplier: 1, score: eye };
    }
    
    // 目なし
    return { rank: 0, name: '目なし (やり直し)', multiplier: 0, score: 0 };
}

// 親と子の勝負判定
function battleChinchiro(playerResult, dealerResult) {
    if (playerResult.rank === -1) return 'lose';
    if (dealerResult.rank === -1) return 'win';
    if (playerResult.rank === 5) return 'win';
    if (dealerResult.rank === 5) return 'lose';

    if (playerResult.rank > dealerResult.rank) return 'win';
    if (playerResult.rank < dealerResult.rank) return 'lose';

    if (playerResult.score > dealerResult.score) return 'win';
    if (playerResult.score < dealerResult.score) return 'lose';
    return 'draw';
}

io.on('connection', (socket) => {
    console.log(`新しい賭博者が接続: ${socket.id}`);

    socket.on('create-room', ({ userName, wallet }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            host: socket.id,
            gameMaster: socket.id,
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
    });

    socket.on('set-game-master', ({ roomId, targetSocketId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        
        const target = room.players.find(p => p.id === targetSocketId);
        if (target) {
            room.gameMaster = targetSocketId;
            io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
        }
    });

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
            socket.emit('error-msg', '有効なベット額ではありません');
            return;
        }

        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);
        console.log(`[部屋 ${roomId}] ${currentPlayer.name} の出目: [${dice.join(', ')}] -> 判定: ${result.name} (rank: ${result.rank})`);

        // 【目なしの場合の処理】：ターンを進めず、同じプレイヤーにもう一度振らせる
        if (result.rank === 0) {
            io.to(roomId).emit('dice-result', {
                playerName: currentPlayer.name,
                dice,
                result,
                isRetry: true,
                nextTurnId: currentPlayer.id,
                nextTurnName: currentPlayer.name,
                players: room.players
            });
            return;
        }

        // 親（gameMaster）自身のターンの場合
        if (currentPlayer.id === room.gameMaster) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            const nextPlayer = room.players[room.currentTurnIndex];

            io.to(roomId).emit('dice-result', {
                playerName: currentPlayer.name,
                dice,
                result,
                isRetry: false,
                isDealerTurn: true,
                nextTurnId: nextPlayer.id,
                nextTurnName: nextPlayer.name,
                players: room.players
            });
            return;
        }

        // 子のターンの場合：親の目を自動生成して勝負
        const dealerDice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];
        const dealerResult = judgeChinchiro(dealerDice);

        let battleResult = 'draw';
        if (dealerResult.rank === 0) {
            battleResult = 'win';
        } else {
            battleResult = battleChinchiro(result, dealerResult);
        }

        const multiplier = result.multiplier || 1;
        let deltaChips = 0;
        const dealerPlayer = room.players.find(p => p.id === room.gameMaster);

        if (battleResult === 'win') {
            deltaChips = bet * multiplier;
            currentPlayer.chips += deltaChips;
            if (dealerPlayer) dealerPlayer.chips -= deltaChips;
        } else if (battleResult === 'lose') {
            deltaChips = bet * multiplier;
            currentPlayer.chips -= deltaChips;
            if (dealerPlayer) dealerPlayer.chips += deltaChips;
        }

        if (currentPlayer.chips < 0) currentPlayer.chips = 0;
        if (dealerPlayer && dealerPlayer.chips < 0) dealerPlayer.chips = 0;

        // 次のプレイヤーへターン進行
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextPlayer = room.players[room.currentTurnIndex];

        io.to(roomId).emit('dice-result', {
            playerName: currentPlayer.name,
            dice,
            result,
            dealerDice,
            dealerResult,
            battleResult,
            deltaChips,
            isRetry: false,
            isDealerTurn: false,
            nextTurnId: nextPlayer.id,
            nextTurnName: nextPlayer.name,
            players: room.players
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
