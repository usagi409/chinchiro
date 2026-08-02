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
    
    if (sorted[0] === 1 && sorted[1] === 1 && sorted[2] === 1) {
        return { rank: 6, name: 'ピンゾロ (5倍)', multiplier: 5, score: 100 };
    }
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 5, name: 'シゴロ (2倍)', multiplier: 2, score: 40 };
    }
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `${sorted[0]}のゾロ目 (3倍)`, multiplier: 3, score: 50 + sorted[0] };
    }
    
    const unique = [...new Set(sorted)];
    if (unique.length === 2) {
        const eye = sorted.find(x => sorted.filter(v => v === x).length === 1);
        return { rank: 3, name: `${eye}の目 (1倍)`, multiplier: 1, score: eye };
    }
    
    if (sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3) {
        return { rank: 1, name: 'ヒフミ (2倍負け)', multiplier: 2, score: -10 };
    }
    
    return { rank: 2, name: '目なし', multiplier: 0, score: 0 };
}

io.on('connection', (socket) => {
    console.log(`新しい賭博者が接続: ${socket.id}`);

    socket.on('create-room', ({ userName, wallet, bet }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            host: socket.id,
            gameMaster: socket.id,
            minBet: 100,
            currentTurnIndex: 0,
            turnsPlayed: 0,
            players: [{
                id: socket.id,
                name: userName,
                chips: wallet !== undefined ? wallet : 1000,
                role: 'host',
                failCount: 0,
                bet: bet !== undefined ? parseInt(bet) || 100 : 100,
                lastDice: null,
                lastResult: null,
                chipDiff: 0
            }],
            status: 'waiting'
        };

        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, gameMaster: rooms[roomId].gameMaster, minBet: rooms[roomId].minBet });
    });

    socket.on('join-room', ({ roomId, userName, wallet, bet }) => {
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

        const userBet = Math.max(room.minBet, parseInt(bet) || room.minBet);

        room.players.push({
            id: socket.id,
            name: userName,
            chips: wallet !== undefined ? wallet : 1000,
            role: 'guest',
            failCount: 0,
            bet: userBet,
            lastDice: null,
            lastResult: null,
            chipDiff: 0
        });

        socket.join(roomId);
        io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster, minBet: room.minBet });
        socket.emit('joined', { roomId, players: room.players, gameMaster: room.gameMaster, minBet: room.minBet });
    });

    socket.on('update-bet', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room || room.status === 'playing') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            const requestedBet = parseInt(bet) || room.minBet;
            player.bet = Math.max(room.minBet, requestedBet);
            io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster, minBet: room.minBet });
        }
    });

    socket.on('update-min-bet', ({ roomId, minBet }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status === 'playing') return;
        
        room.minBet = Math.max(1, parseInt(minBet) || 100);
        room.players.forEach(p => {
            if (p.bet < room.minBet) {
                p.bet = room.minBet;
            }
        });

        io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster, minBet: room.minBet });
    });

    socket.on('set-game-master', ({ roomId, targetSocketId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        
        const target = room.players.find(p => p.id === targetSocketId);
        if (target) {
            room.gameMaster = targetSocketId;
            io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster, minBet: room.minBet });
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
        room.turnsPlayed = 0;
        
        room.players.forEach(p => {
            p.failCount = 0;
            p.lastDice = null;
            p.lastResult = null;
            p.chipDiff = -p.bet; // 初回拠出分
            p.chips -= p.bet; 
        });

        io.to(roomId).emit('game-started', {
            currentTurnId: room.players[room.currentTurnIndex].id,
            gameMasterId: room.gameMaster,
            players: room.players
        });
    });

    socket.on('roll-dice', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('error-msg', 'あなたのターンではありません！');
            return;
        }

        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);

        if (result.rank === 2) {
            currentPlayer.failCount = (currentPlayer.failCount || 0) + 1;
            
            if (currentPlayer.failCount < 3) {
                currentPlayer.lastDice = dice;
                currentPlayer.lastResult = result;
                
                io.to(roomId).emit('dice-result', {
                    playerName: currentPlayer.name,
                    dice,
                    result,
                    isRetry: true,
                    isFinished: false,
                    nextTurnId: currentPlayer.id,
                    nextTurnName: currentPlayer.name,
                    players: room.players
                });
                return;
            }
        }

        currentPlayer.failCount = currentPlayer.failCount || 0;
        currentPlayer.lastDice = dice;
        currentPlayer.lastResult = result;

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        room.turnsPlayed++;

        const isFinished = room.turnsPlayed >= room.players.length;

        if (isFinished) {
            room.status = 'waiting';
            processGameResults(room);
        }

        const nextPlayer = isFinished ? null : room.players[room.currentTurnIndex];

        io.to(roomId).emit('dice-result', {
            playerName: currentPlayer.name,
            dice,
            result,
            isRetry: false,
            isFinished,
            nextTurnId: nextPlayer ? nextPlayer.id : null,
            nextTurnName: nextPlayer ? nextPlayer.name : null,
            players: room.players,
            roundSummary: isFinished ? room.roundSummary : null
        });
    });

    function processGameResults(room) {
        const evaluated = room.players.map(p => {
            const r = p.lastResult || { rank: 2, name: '目なし', multiplier: 0, score: 0 };
            return {
                player: p,
                rank: r.rank,
                score: r.score,
                multiplier: r.multiplier,
                isHifumi: r.rank === 1
            };
        });

        // 1. 基本ポット（全員の初期賭け金の合計）
        let totalPot = room.players.reduce((sum, p) => sum + p.bet, 0);

        // 2. ヒフミのペナルティ修正（「2倍負け」＝初期拠出1倍 ＋ 追加1倍で合計2倍にする）
        evaluated.forEach(e => {
            if (e.isHifumi) {
                const extraPenalty = e.player.bet; // 追加で1倍分を徴収
                e.player.chips -= extraPenalty;
                e.player.chipDiff -= extraPenalty;
                totalPot += extraPenalty; // ペナルティ分もポットに合算
            }
        });

        // 3. 勝者の決定
        let maxRank = -999;
        let maxScore = -999;
        evaluated.forEach(e => {
            if (e.rank > maxRank) {
                maxRank = e.rank;
                maxScore = e.score;
            } else if (e.rank === maxRank && e.score > maxScore) {
                maxScore = e.score;
            }
        });

        let topCandidates = evaluated.filter(e => e.rank === maxRank && e.score === maxScore);
        let winners = [];
        const gmId = room.gameMaster;

        if (topCandidates.length > 1) {
            const hasGm = topCandidates.some(e => e.player.id === gmId);
            if (hasGm) {
                winners = topCandidates.filter(e => e.player.id !== gmId);
                if (winners.length === 0) winners = topCandidates.filter(e => e.player.id === gmId);
            } else {
                winners = topCandidates;
            }
        } else {
            winners = topCandidates;
        }

        // 4. 勝者の最大倍率を取得
        const winnerMult = winners[0] && winners[0].multiplier > 0 ? winners[0].multiplier : 1;

        // 5. 敗者からの追加倍率徴収（シゴロやゾロ目などの倍率に応じてポットが肥大化する）
        evaluated.forEach(e => {
            const isWinner = winners.some(w => w.player.id === e.player.id);
            if (!isWinner && winnerMult > 1) {
                const extra = e.player.bet * (winnerMult - 1);
                e.player.chips -= extra;
                e.player.chipDiff -= extra;
                totalPot += extra; // 敗者からの追加徴収をポットに全額上乗せ
            }
        });

        // 6. ポットの分配（勝者で山分け）
        const share = Math.floor(totalPot / winners.length);

        winners.forEach(w => {
            w.player.chips += share;
            w.player.chipDiff += share;
        });

        room.roundSummary = {
            winnerNames: winners.map(w => `${w.player.name} (${w.player.lastResult.name})`).join(', '),
            totalPot: totalPot,
            resultsDetail: room.players.map(p => ({
                name: p.name,
                dice: p.lastDice,
                resultName: p.lastResult ? p.lastResult.name : '目なし',
                diff: p.chipDiff,
                totalChips: p.chips
            }))
        };
    }

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
                io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster, minBet: room.minBet });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`闇のチンチロ胴元サーバーがポート ${PORT} で起動しました`);
});
