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

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

const rooms = {};

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

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

function applyForcedTitles(room) {
    room.players.forEach(p => {
        if (p.chips < 0) {
            p.isForcedTitle = true;
            p.titleColor = '#ff3366';
            if (p.chips <= -50000) {
                p.forcedTitle = '[臓器の未来を担保にした男]';
            } else if (p.chips <= -10000) {
                p.forcedTitle = '[闇金の優良顧客]';
            } else if (p.chips <= -1000) {
                p.forcedTitle = '[カタギ崩れ]';
            } else {
                p.forcedTitle = '[借金初心者]';
            }
        } else {
            p.isForcedTitle = false;
            p.forcedTitle = null;
        }
    });
}

io.on('connection', (socket) => {
    console.log(`新しい賭博者が接続: ${socket.id}`);

    socket.on('create-room', ({ userName, wallet, bet, title, titleColor }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        const initialChips = wallet !== undefined ? wallet : 1000;
        
        rooms[roomId] = {
            host: socket.id,
            gameMaster: socket.id,
            minBet: 100,
            currentTurnIndex: 0,
            turnsPlayed: 0,
            totalPot: 0,
            players: [{
                id: socket.id,
                name: userName,
                chips: initialChips,
                role: 'host',
                failCount: 0,
                bet: bet !== undefined ? parseInt(bet) || 100 : 100,
                lastDice: null,
                lastResult: null,
                chipDiff: 0,
                title: title || '',
                titleColor: titleColor || '#ffcc00',
                isForcedTitle: false,
                forcedTitle: null
            }],
            status: 'waiting'
        };
        applyForcedTitles(rooms[roomId]);

        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, gameMaster: rooms[roomId].gameMaster, minBet: rooms[roomId].minBet });
    });

    socket.on('join-room', ({ roomId, userName, wallet, bet, title, titleColor }) => {
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
        const initialChips = wallet !== undefined ? wallet : 1000;

        room.players.push({
            id: socket.id,
            name: userName,
            chips: initialChips,
            role: 'guest',
            failCount: 0,
            bet: userBet,
            lastDice: null,
            lastResult: null,
            chipDiff: 0,
            title: title || '',
            titleColor: titleColor || '#ffcc00',
            isForcedTitle: false,
            forcedTitle: null
        });
        applyForcedTitles(room);

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

    socket.on('update-title', ({ roomId, title, titleColor }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && player.chips >= 0) {
            player.title = title || '';
            player.titleColor = titleColor || '#ffcc00';
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
        room.totalPot = 0;
        
        room.players.forEach(p => {
            p.failCount = 0;
            p.lastDice = null;
            p.lastResult = null;
            p.chipDiff = -p.bet;
            p.chips -= p.bet;
            room.totalPot += p.bet;
        });

        applyForcedTitles(room);

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

        // --- 修正された即時変動処理（他のプレイヤーからエネルギーを回収する反応） ---
        if (result.rank === 1) {
            // ヒフミ：自分の賭け金を2倍（自分にペナルティ追加）
            const penalty = currentPlayer.bet;
            currentPlayer.chips -= penalty;
            currentPlayer.chipDiff -= penalty;
            room.totalPot += penalty;
        } else if (result.multiplier > 1) {
            // シゴロ(2倍)、ゾロ目(3倍)、ピンゾロ(5倍)：他のプレイヤー全員から倍率に応じた額を没収しポットに加算
            const multi = result.multiplier;
            room.players.forEach(p => {
                if (p.id !== currentPlayer.id) {
                    const extra = p.bet * (multi - 1);
                    p.chips -= extra;
                    p.chipDiff -= extra;
                    room.totalPot += extra;
                }
            });
        }

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

        const share = Math.floor(room.totalPot / winners.length);

        winners.forEach(w => {
            w.player.chips += share;
            w.player.chipDiff += share;
        });

        applyForcedTitles(room);

        room.roundSummary = {
            winnerNames: winners.map(w => `${w.player.name} (${w.player.lastResult.name})`).join(', '),
            totalPot: room.totalPot,
            resultsDetail: room.players.map(p => ({
                name: p.name,
                dice: p.lastDice,
                resultName: p.lastResult ? p.lastResult.name : '目なし',
                diff: p.chipDiff,
                totalChips: p.chips,
                title: p.isForcedTitle ? p.forcedTitle : p.title,
                titleColor: p.titleColor
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
